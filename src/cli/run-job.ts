import { runRailwayJob, isRailwayJobName, railwayJobNames } from "../jobs/runJob";
import { sql } from "../db/postgres";

async function main(): Promise<void> {
  const job = process.argv[2]?.trim();
  if (!job || !isRailwayJobName(job)) {
    console.error(
      `Unknown or missing job. Use one of: ${railwayJobNames.join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  const result = await runRailwayJob(job);
  console.log(JSON.stringify({ ok: true, job, result }));
}

void main()
  .catch((error) => {
    console.error("railway_job_failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  });
