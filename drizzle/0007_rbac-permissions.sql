ALTER TABLE `household_members` ADD `role` text DEFAULT 'guest' NOT NULL CONSTRAINT "household_members_role" CHECK("household_members"."role" IN ('administrator','collaborator','buyer','guest'));
--> statement-breakpoint
ALTER TABLE `invitations` ADD `role` text DEFAULT 'guest' NOT NULL CONSTRAINT "invitations_role" CHECK("invitations"."role" IN ('administrator','collaborator','buyer','guest'));
