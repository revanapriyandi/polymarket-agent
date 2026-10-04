CREATE TABLE "book_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"market_payload" jsonb NOT NULL,
	"yes_book" jsonb NOT NULL,
	"no_book" jsonb NOT NULL,
	"depth_truncated" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_snapshots" ADD CONSTRAINT "book_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_snapshots_market_time" ON "book_snapshots" USING btree ("market_id","observed_at");--> statement-breakpoint
CREATE INDEX "book_snapshots_time" ON "book_snapshots" USING btree ("observed_at");