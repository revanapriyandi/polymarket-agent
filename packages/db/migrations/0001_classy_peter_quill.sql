ALTER TABLE "fills" ALTER COLUMN "fee" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "fills" ALTER COLUMN "fee" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fills" ADD COLUMN "notional" numeric(38, 12);