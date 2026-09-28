CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `equity_snapshots` (
	`portfolio_id` text NOT NULL,
	`t` integer NOT NULL,
	`equity` real NOT NULL,
	PRIMARY KEY(`portfolio_id`, `t`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `leases` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`intent` text NOT NULL,
	`reason` text NOT NULL,
	`decided_t` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`alpaca_order_id` text,
	`qty` real,
	`notional` real,
	`fill_qty` real,
	`fill_price` real,
	`error` text,
	`submitted_at` integer,
	`filled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `orders_portfolio` ON `orders` (`portfolio_id`);--> statement-breakpoint
CREATE INDEX `orders_status` ON `orders` (`status`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`initial_cash` real NOT NULL,
	`book` text NOT NULL,
	`last_decided_t` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`description` text NOT NULL,
	`backtest` text NOT NULL,
	`public` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tool_runs` (
	`call_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tool_runs_conversation` ON `tool_runs` (`conversation_id`);