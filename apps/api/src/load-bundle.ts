/**
 * The data load job: puts the newest passing bundle from the data pipeline into the graph.
 * Runs as a Cloud Run Job from the API image (`node dist/load-bundle.js`) because the database is only
 * reachable inside the VPC; locally: `pnpm db:load-bundle --bundle pipelines/out/bundles`.
 */
import { parseArgs, runLoadJob, USAGE } from "./services/catalogue/job";

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else {
    const { exitCode } = await runLoadJob(args);
    process.exitCode = exitCode;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
