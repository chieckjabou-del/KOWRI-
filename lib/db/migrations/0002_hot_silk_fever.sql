CREATE TABLE "phone_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"purpose" text DEFAULT 'registration' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"verified_at" timestamp,
	"token_hash" text,
	"token_expires_at" timestamp,
	"consumed_at" timestamp,
	"request_ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "phone_verif_phone_idx" ON "phone_verifications" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "phone_verif_token_idx" ON "phone_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "phone_verif_expires_idx" ON "phone_verifications" USING btree ("expires_at");