CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'student' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lesson_materials` (
	`phrase_id` text PRIMARY KEY NOT NULL,
	`instructions_ru` text DEFAULT '' NOT NULL,
	`instructions_en` text DEFAULT '' NOT NULL,
	`video_key` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lesson_progress` (
	`user_id` text NOT NULL,
	`phrase_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`user_id`, `phrase_id`),
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_lesson_progress_user` ON `lesson_progress` (`user_id`);