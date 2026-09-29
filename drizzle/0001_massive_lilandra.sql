CREATE TABLE `custom_phrases` (
	`id` text PRIMARY KEY NOT NULL,
	`text_ru` text NOT NULL,
	`text_en` text DEFAULT '' NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_custom_phrases_name_key` ON `custom_phrases` (`name_key`);