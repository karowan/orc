#!/usr/bin/env node
// PROTOTYPE — THROWAWAY. Do not ship.
// Question: orc hard-cancel design A — does killing the supervisor's PROCESS GROUP actually reap
// SDK-spawned claude leaf children (which orc never sees a pid for), and does the composite hold:
//   journaled executor pgids  +  supervisor group TERM→KILL  +  external finish record?
// Branch note: logic prototype, but the logic is OS process-group behavior, so this is a runnable
// script (not the usual HTML demo) — it prints the full process/journal state after every action.
//
// Topology mimicked (from orc recon):
//   canceller (this script)                          — the out-of-band hard-cancel path
//     supervisor  spawn(detached:true)               — group LEADER, like spawnDetachedSupervisor
//       sdk-child   spawn(NOT detached)              — like the Agent SDK spawning claude in-process
//         grandchild  spawn(NOT detached)            — like claude spawning a shell
//       executor-child spawn(detached:true)          — like LocalExecutor codex leaves (own group)
//   The sdk-child and grandchild IGNORE SIGTERM — the worst case (wedged leaf).
//   The supervisor "dies without writing finish" — we SIGKILL it alone first to make the zombie.

import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = path.join(process.cwd(), 'PROTOTYPE-scratch');
const role = process.argv[2];

// ---------- child roles ----------
if (role === 'leaf' || role === 'grandchild') {
  process.on('SIGTERM', () => console.log(`[${role} ${process.pid}] ignoring SIGTERM`));
  if (role === 'leaf') {
    const g = spawn(process.execPath, [process.argv[1], 'grandchild'], { stdio: 'inherit' });
    fs.writeFileSync(path.join(dir, 'grandchild.pid'), String(g.pid));
  }
  setInterval(() => {}, 1000);
} else if (role === 'supervisor') {
  const leaf = spawn(process.execPath, [process.argv[1], 'leaf'], { stdio: 'inherit' }); // SDK-style: same group
  const exec_ = spawn(process.execPath, [process.argv[1], 'leaf'], { stdio: 'inherit', detached: true }); // executor-style
  fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(process.pid));      // NEW in design A: journaled
  fs.writeFileSync(path.join(dir, 'sdk-child.pid'), String(leaf.pid));          // known only to us, NOT to orc
  fs.writeFileSync(path.join(dir, 'executor.pgid'), String(exec_.pid));         // NEW in design A: journaled pgid
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ t: 'start', pid: process.pid }) + '\n');
  setInterval(() => {}, 1000); // never writes finish — the zombie case
} else {
  // ---------- the canceller / harness ----------
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  const read = (f) => Number(fs.readFileSync(path.join(dir, f), 'utf8'));
  const ps = (pids) => {
    console.log('  PID    PGID   ALIVE  WHO');
    for (const [who, pid] of Object.entries(pids)) {
      let pgid = '?';
      try { pgid = execSync(`ps -o pgid= -p ${pid}`).toString().trim(); } catch {}
      console.log(`  ${String(pid).padEnd(7)}${String(pgid).padEnd(7)}${String(alive(pid)).padEnd(7)}${who}`);
    }
  };
  const project = () => {
    const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const finish = lines.findLast((l) => l.t === 'finish');
    return finish ? finish.status : 'running';
  };

  const sup = spawn(process.execPath, [process.argv[1], 'supervisor'], { stdio: 'inherit', detached: true });
  sup.unref();
  await sleep(700); // let the tree settle
  const pids = {
    supervisor: read('supervisor.pid'),
    'sdk-child (TERM-ignoring)': read('sdk-child.pid'),
    'grandchild (TERM-ignoring)': read('grandchild.pid'),
    'executor-child (own group)': read('executor.pgid'),
  };
  const supPgid = pids.supervisor;         // detached ⇒ leader ⇒ pgid === pid
  const execPgid = read('executor.pgid');

  console.log('\n== 1. TOPOLOGY — the premise: SDK child + grandchild share the supervisor group =='); ps(pids);

  console.log('\n== 2. ZOMBIE — SIGKILL the supervisor alone (dies without writing finish) ==');
  process.kill(pids.supervisor, 'SIGKILL'); await sleep(300); ps(pids);
  console.log(`  projection says: "${project()}"   supervisor alive: ${alive(pids.supervisor)}   <-- the lie (gap 1)`);
  console.log(`  liveness probe (design A): supervisor pid dead + no finish record ⇒ hard-cancel may act`);

  console.log('\n== 3. HARD-CANCEL — TERM the supervisor GROUP (orphaned SDK children keep its pgid) ==');
  try { process.kill(-supPgid, 'SIGTERM'); } catch (e) { console.log('  group TERM:', e.code); }
  await sleep(500); ps(pids);
  console.log(`  sdk-child+grandchild ignored TERM (by design of the test) — group still alive: ${groupAlive(supPgid)}`);

  console.log('\n== 4. ESCALATE — KILL the supervisor group after grace ==');
  try { process.kill(-supPgid, 'SIGKILL'); } catch (e) { console.log('  group KILL:', e.code); }
  await sleep(300); ps(pids);
  console.log(`  supervisor group gone: ${!groupAlive(supPgid)}   executor group still alive: ${groupAlive(execPgid)}  <-- the hammer misses re-detached executors`);

  console.log('\n== 5. JOURNALED EXECUTOR PGID — kill the recorded group ==');
  try { process.kill(-execPgid, 'SIGKILL'); } catch (e) { console.log('  exec group KILL:', e.code); }
  await sleep(300); ps(pids);

  console.log('\n== 6. EXTERNAL FINISH RECORD — the canceller writes what the dead supervisor could not ==');
  fs.appendFileSync(path.join(dir, 'journal.jsonl'),
    JSON.stringify({ t: 'finish', status: 'cancelled', error: 'cancelled by operator (hard)', by: 'canceller' }) + '\n');
  console.log('  journal:'); for (const l of fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n')) console.log('   ', l);
  console.log(`  projection now says: "${project()}"`);

  const verdict = !groupAlive(supPgid) && !groupAlive(execPgid) && project() === 'cancelled';
  console.log(`\n== VERDICT: composite design A ${verdict ? 'HOLDS' : 'FAILS'} on this platform ==`);
  fs.rmSync(dir, { recursive: true, force: true });
}
