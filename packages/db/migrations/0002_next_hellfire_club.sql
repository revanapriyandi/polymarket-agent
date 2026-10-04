DROP INDEX "tool_job_key";--> statement-breakpoint
CREATE UNIQUE INDEX "tool_job_key" ON "tool_runs" USING btree ("job_id","role","tool");