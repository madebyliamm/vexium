// FULL BUILD (REVAMP Step 10) — the Cloudflare Workflow that builds a whole site. Deliberately thin: the control flow is build-flow.ts,
// the connections are build-ports.ts, and every prompt/check/save decision lives in ai-chat. A Workflow keeps going after the browser
// is closed, retries a step that failed, and has no 30-second limit (the reason the long stages could not run in ctx.waitUntil).
//
// Started by worker.ts when ai-chat answers a `build` prepare with `kind: "workflow"` (instance id = the build_jobs row id).

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { runBuild, type Steps } from './build-flow.ts';
import { makePorts, type PortsEnv } from './build-ports.ts';

interface WorkflowStep {
  do<T>(name: string, config: { retries: { limit: number; delay: string; backoff: 'constant' | 'linear' | 'exponential' }; timeout: string }, cb: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number | string): Promise<void>;
}

export interface BuildParams {
  job_id: string;
}

export class BuildWorkflow extends WorkflowEntrypoint<PortsEnv, BuildParams> {
  async run(event: { payload: BuildParams }, step: WorkflowStep) {
    const jobId = event.payload.job_id;
    const steps: Steps = {
      run: (name, o, cb) => step.do(name, { retries: { limit: o.retries, delay: '5 seconds', backoff: 'exponential' }, timeout: o.timeout }, cb),
      sleep: (name, seconds) => step.sleep(name, `${seconds} seconds`),
    };
    return await runBuild(jobId, steps, makePorts(this.env, jobId, fetch, (m) => new NonRetryableError(m)));
  }
}
