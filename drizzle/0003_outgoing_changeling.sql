CREATE TABLE `archived_phrases` (
	`phrase_id` text PRIMARY KEY NOT NULL,
	`archived_at` integer NOT NULL,
	`archived_by` text NOT NULL,
	FOREIGN KEY (`archived_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
