import type { Client, User } from "@enmo/db";
import {
  CreateClientRequest,
  ROLE_LABEL,
  slugify,
  type CreateClientInput,
  type Role,
} from "@enmo/shared";
import { hash } from "@node-rs/argon2";
import { testDb } from "./db";

/* Rows created straight through Prisma, bypassing the API, for arranging test state. */

export const DEFAULT_TEST_PASSWORD = "correct-horse-battery-staple";

let sequence = 0;
const nextId = () => ++sequence;

export interface CreateUserInput {
  role?: Role;
  password?: string;
  email?: string;
  name?: string;
  isActive?: boolean;
}

/** The stored user plus the plaintext password, so tests can log in as them. */
export type TestUser = User & { password: string };

export async function createUser(input: CreateUserInput = {}): Promise<TestUser> {
  const n = nextId();
  const role = input.role ?? "EDITOR";
  const password = input.password ?? DEFAULT_TEST_PASSWORD;
  const user = await testDb().user.create({
    data: {
      email: (input.email ?? `${role.toLowerCase()}-${n}@enmo.test`).trim().toLowerCase(),
      name: input.name ?? `Test ${ROLE_LABEL[role]} ${n}`,
      role,
      isActive: input.isActive ?? true,
      passwordHash: await hash(password),
    },
  });
  return { ...user, password };
}

export type CreateTestClientInput = Partial<CreateClientInput> & { archivedAt?: Date | null };

/** Fills every field with the same defaults as POST /v1/clients; the slug gets a unique suffix. */
export async function createClient(input: CreateTestClientInput = {}): Promise<Client> {
  const n = nextId();
  const { archivedAt = null, ...request } = input;
  const data = CreateClientRequest.parse({ name: `Test Client ${n}`, ...request });
  return testDb().client.create({
    data: { ...data, slug: data.slug ?? `${slugify(data.name)}-${n}`, archivedAt },
  });
}
