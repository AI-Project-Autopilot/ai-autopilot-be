-- Retire the old email/password project-management schema.
-- GitHub identities, sessions, OAuth state, and saved analyses are independent.
-- Do not use CASCADE: unexpected dependencies must stop the migration.
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TABLE "Task_files";
DROP TABLE "Comments";
DROP TABLE "Subtasks";
DROP TABLE "Task_tags";
DROP TABLE "Invitations";
DROP TABLE "Project_members";
DROP TABLE "Tokens";
DROP TABLE "Tasks";
DROP TABLE "Tags";
DROP TABLE "Projects";
DROP TABLE "Users";

DROP TYPE "invitation_status";
DROP TYPE "task_status";

COMMIT;
