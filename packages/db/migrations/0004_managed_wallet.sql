CREATE TABLE "managed_wallet" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"signer_address" text NOT NULL,
	"wallet_address" text,
	"secrets" text NOT NULL,
	"status" text DEFAULT 'configured' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
