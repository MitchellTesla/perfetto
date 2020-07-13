/*
 * Copyright (C) 2020 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "src/profiling/memory/client_ext_factory.h"

#include "perfetto/ext/base/unix_socket.h"
#include "perfetto/ext/base/utils.h"
#include "perfetto/profiling/memory/client_ext.h"

#include "perfetto/ext/base/unix_task_runner.h"
#include "perfetto/ext/base/watchdog.h"
#include "perfetto/ext/tracing/ipc/default_socket.h"
#include "src/profiling/common/proc_utils.h"
#include "src/profiling/memory/heapprofd_producer.h"

#include <string>

#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

// General approach:
// On loading this library, we fork off a process that runs heapprofd. We
// share a control socket pair (g_child_sock in client, srv_sock in service)
// which is used to:
// * Signal a new profiling session was started by sending a byte to
//   g_child_sock. This signal gets received in MonitorFd.
// * For each profiling session, send a new socket from the client to the
//   service. This happens in CreateClient.

namespace perfetto {
namespace profiling {
namespace {

base::UnixSocketRaw* g_client_sock;

void MonitorFd() {
  PERFETTO_DCHECK(g_client_sock->IsBlocking());
  for (;;) {
    char buf[1];
    ssize_t r = g_client_sock->Receive(buf, sizeof(buf));
    if (r >= 1) {
      heapprofd_init_session(malloc, free);
    } else if (r == 0) {
      PERFETTO_ELOG("Server disconneced.");
      break;
    } else {
      PERFETTO_PLOG("Receive failed.");
    }
  }
}

__attribute__((constructor)) void ForkHeapprofd() {
  pid_t pid = getpid();
  std::string cmdline;

  if (!GetCmdlineForPID(pid, &cmdline)) {
    PERFETTO_ELOG("Failed to get cmdline.");
  }

  g_client_sock = new base::UnixSocketRaw();
  base::UnixSocketRaw srv_sock;
  base::UnixSocketRaw cli_sock;

  std::tie(cli_sock, srv_sock) = base::UnixSocketRaw::CreatePair(
      base::SockFamily::kUnix, base::SockType::kStream);

  if (!cli_sock || !srv_sock) {
    PERFETTO_ELOG("Failed to create socket pair.");
    return;
  }

  pid_t f = fork();
  if (f == -1) {
    PERFETTO_PLOG("fork");
    return;
  }
  if (f != 0) {
    int wstatus;
    if (PERFETTO_EINTR(waitpid(f, &wstatus, 0)) == -1)
      PERFETTO_PLOG("waitpid");
    *g_client_sock = std::move(cli_sock);
    std::thread th(MonitorFd);
    th.detach();
    return;
  }

  daemon(/* nochdir= */ 0, /* noclose= */ 1);

  cli_sock.ReleaseFd();

  // Leave stderr open for logging.
  int null = open("/dev/null", O_RDWR);
  dup2(null, STDIN_FILENO);
  dup2(null, STDOUT_FILENO);
  if (null > STDERR_FILENO)
    close(null);

  for (int i = STDERR_FILENO + 1; i < 512; ++i) {
    if (i != srv_sock.fd())
      close(i);
  }

  srv_sock.SetBlocking(false);

  base::UnixTaskRunner task_runner;
  base::Watchdog::GetInstance()->Start();  // crash on exceedingly long tasks
  HeapprofdProducer producer(HeapprofdMode::kChild, &task_runner,
                             /* is_oneshot= */ false);
  producer.SetTargetProcess(pid, cmdline);
  producer.ConnectWithRetries(GetProducerSocket());
  // Signal MonitorFd in the parent process to start a session.
  producer.SetDataSourceCallback([&srv_sock] { srv_sock.Send("x", 1); });
  task_runner.AddFileDescriptorWatch(srv_sock.fd(), [&producer, &srv_sock] {
    base::ScopedFile fd;
    char buf[1];
    ssize_t r = srv_sock.Receive(buf, sizeof(buf), &fd, 1);
    if (r == 0) {
      PERFETTO_LOG("Child disconnected.");
      _exit(0);
    }
    if (r == -1 && !base::IsAgain(errno)) {
      PERFETTO_PLOG("Receive");
    }
    if (fd) {
      producer.AdoptSocket(std::move(fd));
    }
  });
  task_runner.Run();
}

}  // namespace

// This is called by heapprofd_init_session (client_ext.cc) to construct a
// client.
std::shared_ptr<Client> ConstructClient(
    UnhookedAllocator<perfetto::profiling::Client> unhooked_allocator) {
  std::shared_ptr<perfetto::profiling::Client> client;
  base::UnixSocketRaw srv_session_sock;
  base::UnixSocketRaw client_session_sock;

  std::tie(srv_session_sock, client_session_sock) =
      base::UnixSocketRaw::CreatePair(base::SockFamily::kUnix,
                                      base::SockType::kStream);
  if (!client_session_sock || !srv_session_sock) {
    PERFETTO_ELOG("Failed to create socket pair.");
    return nullptr;
  }
  base::ScopedFile srv_fd = srv_session_sock.ReleaseFd();
  int fd = srv_fd.get();
  // Send the session socket to the service.
  g_client_sock->Send(" ", 1, &fd, 1);
  return perfetto::profiling::Client::CreateAndHandshake(
      std::move(client_session_sock), unhooked_allocator);
}

}  // namespace profiling
}  // namespace perfetto
