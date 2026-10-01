CREATE TABLE `envelope_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`from_category_id` text NOT NULL,
	`to_category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text NOT NULL,
	`date` text NOT NULL,
	FOREIGN KEY (`from_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_envelope_transfers_date` ON `envelope_transfers` (`date`);
