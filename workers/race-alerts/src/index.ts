/**
 * recall-race-alerts: the scheduled Worker that sends the race emails (README "Race emails"). The cron
 * (wrangler.toml, every 10 minutes) runs run.ts once; any other request is a 404. Typed with small local
 * interfaces (no workers-types here), as functions/ does with D1Like.
 */
import { runRaceAlerts, type AlertsWorkerEnv } from './run';

interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}
interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async scheduled(_controller: ScheduledControllerLike, env: AlertsWorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    const run = runRaceAlerts(env).then(
      (r) => console.log(`[recall race-alerts] ${JSON.stringify(r)}`),
      (e: unknown) => console.error(`[recall race-alerts] run failed: ${e instanceof Error ? e.message : 'error'}`),
    );
    ctx.waitUntil(run);
    await run;
  },
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
};
