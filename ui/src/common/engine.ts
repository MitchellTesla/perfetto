// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {defer, Deferred} from '../base/deferred';
import {assertExists} from '../base/logging';
import {perfetto} from '../gen/protos';

import {ProtoRingBuffer} from './proto_ring_buffer';
import {
  ComputeMetricArgs,
  ComputeMetricResult,
  RawQueryArgs,
  RawQueryResult
} from './protos';
import {iter, NUM_NULL, slowlyCountRows, STR} from './query_iterator';
import {TimeSpan} from './time';

import TraceProcessorRpc = perfetto.protos.TraceProcessorRpc;
import TraceProcessorRpcStream = perfetto.protos.TraceProcessorRpcStream;
import TPM = perfetto.protos.TraceProcessorRpc.TraceProcessorMethod;

export interface LoadingTracker {
  beginLoading(): void;
  endLoading(): void;
}

export class NullLoadingTracker implements LoadingTracker {
  beginLoading(): void {}
  endLoading(): void {}
}

export class QueryError extends Error {}

/**
 * Abstract interface of a trace proccessor.
 * This is the TypeScript equivalent of src/trace_processor/rpc.h.
 * There are two concrete implementations:
 *   1. WasmEngineProxy: creates a Wasm module and interacts over postMessage().
 *   2. HttpRpcEngine: connects to an external `trace_processor_shell --httpd`.
 *      and interacts via fetch().
 * In both cases, we have a byte-oriented pipe to interact with TraceProcessor.
 * The derived class is only expected to deal with these two functions:
 * 1. Implement the abstract rpcSendRequestBytes() function, sending the
 *    proto-encoded TraceProcessorRpc requests to the TraceProcessor instance.
 * 2. Call onRpcResponseBytes() when response data is received.
 */
export abstract class Engine {
  abstract readonly id: string;
  private _cpus?: number[];
  private _numGpus?: number;
  private loadingTracker: LoadingTracker;
  private txSeqId = 0;
  private rxSeqId = 0;
  private rxBuf = new ProtoRingBuffer();
  private pendingParses = new Array<Deferred<void>>();
  private pendingEOFs = new Array<Deferred<void>>();
  private pendingRawQueries = new Array<Deferred<RawQueryResult>>();
  private pendingRestoreTables = new Array<Deferred<void>>();
  private pendingComputeMetrics = new Array<Deferred<ComputeMetricResult>>();

  constructor(tracker?: LoadingTracker) {
    this.loadingTracker = tracker ? tracker : new NullLoadingTracker();
  }

  /**
   * Called to send data to the TraceProcessor instance. This turns into a
   * postMessage() or a HTTP request, depending on the Engine implementation.
   */
  abstract rpcSendRequestBytes(data: Uint8Array): void;

  /**
   * Called when an inbound message is received by the Engine implementation
   * (e.g. onmessage for the Wasm case, on when HTTP replies are received for
   * the HTTP+RPC case).
   */
  onRpcResponseBytes(dataWillBeRetained: Uint8Array) {
    // Note: when hitting the fastpath inside ProtoRingBuffer, the |data| buffer
    // is returned back by readMessage() (% subarray()-ing it) and held onto by
    // other classes (e.g., QueryResult). For both fetch() and Wasm we are fine
    // because every response creates a new buffer.
    this.rxBuf.append(dataWillBeRetained);
    for (;;) {
      const msg = this.rxBuf.readMessage();
      if (msg === undefined) break;
      this.onRpcResponseMessage(msg);
    }
  }

  /*
   * Parses a response message.
   * |rpcMsgEncoded| is a sub-array to to the start of a TraceProcessorRpc
   * proto-encoded message (without the proto preamble and varint size).
   */
  private onRpcResponseMessage(rpcMsgEncoded: Uint8Array) {
    const rpc = TraceProcessorRpc.decode(rpcMsgEncoded);
    this.loadingTracker.endLoading();

    if (rpc.fatalError !== undefined && rpc.fatalError.length > 0) {
      throw new Error(`${rpc.fatalError}`);
    }

    // Allow restarting sequences from zero (when reloading the browser).
    if (rpc.seq !== this.rxSeqId + 1 && this.rxSeqId !== 0 && rpc.seq !== 0) {
      // "(ERR:rpc_seq)" is intercepted by error_dialog.ts to show a more
      // graceful and actionable error.
      throw new Error(`RPC sequence id mismatch cur=${rpc.seq} last=${
          this.rxSeqId} (ERR:rpc_seq)`);
    }

    this.rxSeqId = rpc.seq;

    switch (rpc.response) {
      case TPM.TPM_APPEND_TRACE_DATA:
        const appendResult = assertExists(rpc.appendResult);
        const pendingPromise = assertExists(this.pendingParses.shift());
        if (appendResult.error && appendResult.error.length > 0) {
          pendingPromise.reject(appendResult.error);
        } else {
          pendingPromise.resolve();
        }
        break;
      case TPM.TPM_FINALIZE_TRACE_DATA:
        assertExists(this.pendingEOFs.shift()).resolve();
        break;
      case TPM.TPM_RESTORE_INITIAL_TABLES:
        assertExists(this.pendingRestoreTables.shift()).resolve();
        break;
      case TPM.TPM_QUERY_STREAMING:
        // TODO(primiano): In the next CLs wire up the streaming query decoder.
        break;
      case TPM.TPM_QUERY_RAW_DEPRECATED:
        const queryRes = assertExists(rpc.rawQueryResult) as RawQueryResult;
        assertExists(this.pendingRawQueries.shift()).resolve(queryRes);
        break;
      case TPM.TPM_COMPUTE_METRIC:
        const metricRes = assertExists(rpc.metricResult) as ComputeMetricResult;
        if (metricRes.error && metricRes.error.length > 0) {
          throw new QueryError(`ComputeMetric() error: ${metricRes.error}`);
        }
        assertExists(this.pendingComputeMetrics.shift()).resolve(metricRes);
        break;
      default:
        console.log(
            'Unexpected TraceProcessor response received: ', rpc.response);
        break;
    }  // switch(rpc.response);
  }

  /**
   * TraceProcessor methods below this point.
   * The methods below are called by the various controllers in the UI and
   * deal with marshalling / unmarshaling requests to/from TraceProcessor.
   */


  /**
   * Push trace data into the engine. The engine is supposed to automatically
   * figure out the type of the trace (JSON vs Protobuf).
   */
  parse(data: Uint8Array): Promise<void> {
    const asyncRes = defer<void>();
    this.pendingParses.push(asyncRes);
    const rpc = TraceProcessorRpc.create();
    rpc.request = TPM.TPM_APPEND_TRACE_DATA;
    rpc.appendTraceData = data;
    this.rpcSendRequest(rpc);
    return asyncRes;  // Linearize with the worker.
  }

  /**
   * Notify the engine that we reached the end of the trace.
   * Called after the last parse() call.
   */
  notifyEof(): Promise<void> {
    const asyncRes = defer<void>();
    this.pendingEOFs.push(asyncRes);
    const rpc = TraceProcessorRpc.create();
    rpc.request = TPM.TPM_FINALIZE_TRACE_DATA;
    this.rpcSendRequest(rpc);
    return asyncRes;  // Linearize with the worker.
  }

  /**
   * Resets the trace processor state by destroying any table/views created by
   * the UI after loading.
   */
  restoreInitialTables(): Promise<void> {
    const asyncRes = defer<void>();
    this.pendingRestoreTables.push(asyncRes);
    const rpc = TraceProcessorRpc.create();
    rpc.request = TPM.TPM_RESTORE_INITIAL_TABLES;
    this.rpcSendRequest(rpc);
    return asyncRes;  // Linearize with the worker.
  }

  /**
   * Shorthand for sending a compute metrics request to the engine.
   */
  async computeMetric(metrics: string[]): Promise<ComputeMetricResult> {
    const asyncRes = defer<ComputeMetricResult>();
    this.pendingComputeMetrics.push(asyncRes);
    const rpc = TraceProcessorRpc.create();
    rpc.request = TPM.TPM_COMPUTE_METRIC;
    const args = rpc.computeMetricArgs = new ComputeMetricArgs();
    args.metricNames = metrics;
    args.format = ComputeMetricArgs.ResultFormat.TEXTPROTO;
    this.rpcSendRequest(rpc);
    return asyncRes;
  }

  /**
   * Runs a SQL query and throws if the query failed.
   * Queries performed by the controller logic should use this.
   */
  async query(sqlQuery: string): Promise<RawQueryResult> {
    const result = await this.uncheckedQuery(sqlQuery);
    if (result.error) {
      throw new QueryError(`Query error "${sqlQuery}": ${result.error}`);
    }
    return result;
  }

  /**
   * Runs a SQL query. Does not throw if the query fails.
   * The caller must handle this failure. This is so this function can be safely
   * used for user-typed SQL.
   */
  uncheckedQuery(sqlQuery: string): Promise<RawQueryResult> {
    const asyncRes = defer<RawQueryResult>();
    this.pendingRawQueries.push(asyncRes);
    const rpc = TraceProcessorRpc.create();
    rpc.request = TPM.TPM_QUERY_RAW_DEPRECATED;
    rpc.rawQueryArgs = new RawQueryArgs();
    rpc.rawQueryArgs.sqlQuery = sqlQuery;
    rpc.rawQueryArgs.timeQueuedNs = Math.floor(performance.now() * 1e6);
    this.rpcSendRequest(rpc);
    return asyncRes;
  }

  async queryOneRow(query: string): Promise<number[]> {
    const result = await this.query(query);
    const res: number[] = [];
    if (slowlyCountRows(result) === 0) return res;
    for (const col of result.columns) {
      if (col.longValues!.length === 0) {
        console.error(
            `queryOneRow should only be used for queries that return long values
             : ${query}`);
        throw new Error(
            `queryOneRow should only be used for queries that return long values
             : ${query}`);
      }
      res.push(+col.longValues![0]);
    }
    return res;
  }

  /**
   * Marshals the TraceProcessorRpc request arguments and sends the request
   * to the concrete Engine (Wasm or HTTP).
   */
  private rpcSendRequest(rpc: TraceProcessorRpc) {
    rpc.seq = this.txSeqId++;
    // Each message is wrapped in a TraceProcessorRpcStream to add the varint
    // preamble with the size, which allows tokenization on the other end.
    const outerProto = TraceProcessorRpcStream.create();
    outerProto.msg.push(rpc);
    const buf = TraceProcessorRpcStream.encode(outerProto).finish();
    this.loadingTracker.beginLoading();
    this.rpcSendRequestBytes(buf);
  }

  // TODO(hjd): When streaming must invalidate this somehow.
  async getCpus(): Promise<number[]> {
    if (!this._cpus) {
      const result =
          await this.query('select distinct(cpu) from sched order by cpu;');
      if (slowlyCountRows(result) === 0) return [];
      this._cpus = result.columns[0].longValues!.map(n => +n);
    }
    return this._cpus;
  }

  async getNumberOfGpus(): Promise<number> {
    if (!this._numGpus) {
      const result = await this.query(`
        select count(distinct(gpu_id)) as gpuCount
        from gpu_counter_track
        where name = 'gpufreq';
      `);
      this._numGpus = +result.columns[0].longValues![0];
    }
    return this._numGpus;
  }

  // TODO: This should live in code that's more specific to chrome, instead of
  // in engine.
  async getNumberOfProcesses(): Promise<number> {
    const result = await this.query('select count(*) from process;');
    return +result.columns[0].longValues![0];
  }

  async getTraceTimeBounds(): Promise<TimeSpan> {
    const query = `select start_ts, end_ts from trace_bounds`;
    const res = (await this.queryOneRow(query));
    return new TimeSpan(res[0] / 1e9, res[1] / 1e9);
  }

  async getTracingMetadataTimeBounds(): Promise<TimeSpan> {
    const query = await this.query(`select name, int_value from metadata
         where name = 'tracing_started_ns' or name = 'tracing_disabled_ns'
         or name = 'all_data_source_started_ns'`);
    let startBound = -Infinity;
    let endBound = Infinity;
    const it = iter({'name': STR, 'int_value': NUM_NULL}, query);
    for (; it.valid(); it.next()) {
      const columnName = it.row.name;
      const timestamp = it.row.int_value;
      if (timestamp === null) continue;
      if (columnName === 'tracing_disabled_ns') {
        endBound = Math.min(endBound, timestamp / 1e9);
      } else {
        startBound = Math.max(startBound, timestamp / 1e9);
      }
    }

    return new TimeSpan(startBound, endBound);
  }
}
