import { ProcessingJobRow } from '../domain';
import { AgentPipeline } from '../services/agentPipeline';
import { Repository } from '../services/repository';

export class AgentWorker {
  private idleTimer: NodeJS.Timeout | null = null;
  private activeCount = 0;
  private stopped = true;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    private readonly repository: Repository,
    private readonly pipeline: AgentPipeline,
    private readonly workerId: string,
    private readonly workerPool: ProcessingJobRow['worker_pool'],
    private readonly concurrency: number,
    private readonly idlePollMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.startListening();
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.unlisten) void this.unlisten();
    this.unlisten = null;
  }

  private async startListening(): Promise<void> {
    try {
      this.unlisten = await this.repository.listenForJobNotifications(this.workerPool, () => {
        this.pump();
      });
    } catch (error) {
      console.error(`agent-worker listen failed for pool ${this.workerPool}`, error);
    }
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.activeCount < this.concurrency) {
      this.activeCount += 1;
      void this.runOne();
    }
  }

  private scheduleIdlePoll(): void {
    if (this.stopped || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.pump();
    }, this.idlePollMs);
  }

  private async runOne(): Promise<void> {
    let claimedJob = false;
    try {
      const job = await this.repository.claimJob(this.workerId, this.workerPool);
      if (!job) return;
      claimedJob = true;
      try {
        await this.pipeline.handleJob(job);
      } catch (error) {
        await this.repository.markJobFailed(job, error);
      }
    } finally {
      this.activeCount -= 1;
      if (claimedJob) this.pump();
      else this.scheduleIdlePoll();
    }
  }
}
