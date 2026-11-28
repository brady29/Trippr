# Operations: backups, restore and the restore drill

Production keeps everything the group has done (routes, votes, comments,
bookings, expenses, inbox items) in one FalkorDB graph on a small VM. This page
is the runbook for keeping a copy of it and getting it back.

There are three layers, each covering a different failure:

| Layer | Covers | How often | Kept |
|---|---|---|---|
| AOF on the VM's disk | A FalkorDB or VM restart | Every second (`appendfsync everysec`) | Live |
| Disk snapshots of the VM | The disk or VM being lost, a bad OS update | Daily | 14 days |
| Graph backups in Cloud Storage | A bad deploy or bad data written by the app; moving to a new database | Daily, checked by a restore drill | 14 daily, 8 weekly, 12 monthly |

## 1. Daily graph backup (Cloud Run Job)

The VM is only reachable inside the VPC, so the backup runs as a Cloud Run Job
from the API image, with the same network settings as the API. It exports the
graph, writes `trippr-YYYY-MM-DD.json.gz` to the bucket, restores that file
into a scratch graph and checks every label and relationship count matches,
then prunes old backups. Exit code 1 (a failed export, upload or drill) shows
up as a failed execution.

One-time setup (replace the values in capitals):

```bash
gcloud storage buckets create gs://BUCKET --location us-central1 --uniform-bucket-level-access
```

```bash
gcloud run jobs create trippr-backup \
  --image us-central1-docker.pkg.dev/PROJECT/trippr/api:latest \
  --region us-central1 \
  --command node --args dist/backup.js,--drill \
  --network default --subnet default --vpc-egress private-ranges-only \
  --set-env-vars NODE_ENV=production,BACKUP_LOCATION=gs://BUCKET/graph \
  --set-secrets FALKORDB_URL=trippr-falkordb-url:latest \
  --memory 1Gi --task-timeout 900 --max-retries 1
```

```bash
gcloud scheduler jobs create http trippr-backup-daily \
  --location us-central1 --schedule "17 3 * * *" --time-zone UTC \
  --uri "https://run.googleapis.com/v2/projects/PROJECT/locations/us-central1/jobs/trippr-backup:run" \
  --http-method POST --oauth-service-account-email SCHEDULER_SA@PROJECT.iam.gserviceaccount.com
```

The job's service account needs `roles/storage.objectAdmin` on the bucket (it
deletes old backups), and the scheduler's account needs `roles/run.invoker` on
the job. `deploy.yml` updates the job's image on every deploy once it exists.

Settings: `BACKUP_LOCATION` (gs://bucket/prefix or a folder), `BACKUP_DRILL`
(`true` is the same as `--drill`), and `BACKUP_KEEP_DAILY` / `_WEEKLY` /
`_MONTHLY` (14 / 8 / 12).

Run it now, or locally:

```bash
gcloud run jobs execute trippr-backup --region us-central1 --wait
```

```bash
pnpm db:backup --location ./backups --drill
```

For a database GitHub can reach (AuraDB), `.github/workflows/backup.yml` does
the same export daily once `BACKUP_BUCKET` is set.

## 2. Disk snapshots of the VM

```bash
gcloud compute resource-policies create snapshot-schedule trippr-daily \
  --region us-central1 --daily-schedule --start-time 04:00 \
  --max-retention-days 14 --on-source-disk-delete keep-auto-snapshots
```

```bash
gcloud compute disks add-resource-policies FALKORDB_VM_BOOT_DISK \
  --zone us-central1-a --resource-policies trippr-daily
```

Snapshots of a free-tier disk are billed per GB stored; 14 days of a 10 GB disk
with little churn costs cents a month.

## 3. Restoring

Backups do not include place vectors (4 KB each); after a restore, run the
catalogue load job (`pnpm db:load-bundle`) to put them back. Everything the
group made is in the backup.

`pnpm db:restore` only writes into an empty graph, so it can never mix a
backup into live data. To bring production back from a backup:

1. Pick the backup: `gcloud storage ls gs://BUCKET/graph/`.
2. From a machine inside the VPC (or an SSH tunnel to the VM), restore into a
   new graph name:

   ```bash
   FALKORDB_URL=redis://VM_IP:6379 pnpm db:restore gs://BUCKET/graph --date 2026-11-27 --graph trippr_restored
   ```

   It applies the schema, rebuilds every node and relationship and checks the
   counts against the file.
3. Point the API at it: set `FALKORDB_GRAPH=trippr_restored` on the
   `trippr-api` service (and the jobs) and deploy. The old graph stays as it was
   until you delete it with `GRAPH.DELETE trippr`.
4. Run the load job for place vectors.

To restore a disk snapshot instead (the VM itself is gone), create a disk from
the newest snapshot, create the VM from it with the same static internal IP,
and the API reconnects on its own (it retries while the database boots).

## 4. The restore drill

The daily job's `--drill` proves every backup can be restored, but it restores
into the same FalkorDB. Once a quarter, and before the trip leaves, do the
whole thing by hand on a laptop, which also proves the instructions above:

```bash
pnpm db:up
```

```bash
gcloud storage cp gs://BUCKET/graph/trippr-$(date -u +%F).json.gz .
```

```bash
FALKORDB_GRAPH=drill pnpm db:restore trippr-$(date -u +%F).json.gz
```

Then start the API with `FALKORDB_GRAPH=drill`, open the trip and check the
routes, bookings and expenses look right. Note the date and how long it took
at the bottom of this page.

| Date | Backup | Time to restore | By |
|---|---|---|---|
| | | | |
