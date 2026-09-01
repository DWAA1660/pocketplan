CREATE TABLE `budget_months` (
	`month` text PRIMARY KEY NOT NULL,
	`finalized` integer DEFAULT 0 NOT NULL,
	`finalized_at` text
);
--> statement-breakpoint
CREATE TABLE `category_monthly_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`month` text NOT NULL,
	`limit_cents` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_category_limits_month` ON `category_monthly_limits` (`month`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_category_limits_category_month` ON `category_monthly_limits` (`category_id`,`month`);
