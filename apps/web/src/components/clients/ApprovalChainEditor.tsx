"use client";

import {
  APPROVAL_CHAIN_MAX_STEPS,
  APPROVAL_STEP_MAX_APPROVALS,
  ApprovalChain,
  defaultApprovalChain,
  eligibleApprovers,
  Role,
  ROLE_LABEL,
  type ApprovalStep,
  type ClientDto,
  type TeamMember,
} from "@enmo/shared";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cx } from "@/components/ui/cx";
import { FieldError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useReplaceApprovalChain } from "@/hooks/useClients";
import { useTeamDirectory } from "@/hooks/useTeam";
import { errorMessage } from "@/lib/api";
import { chainTeamIssues } from "./chain-health";
import { EditorForm, EditorSection, SaveBar } from "./EditorFrame";

/*
 * ApprovalChainEditor (DESIGN §E): 1–5 ordered steps, each with a name, approver roles, named
 * approvers and how many approvals complete it. Validated live with the shared ApprovalChain schema
 * and against the team directory (every step needs enough active teammates who may decide it, as
 * the API checks too), then saved as a whole with PUT /clients/:id/approval-chain.
 */

interface DraftStep extends ApprovalStep {
  /** Stable React key; never sent to the API. */
  key: string;
}

const toDraft = (chain: ApprovalChain, prefix: string): DraftStep[] =>
  chain.steps.map((step, index) => ({
    ...step,
    approverRoles: [...step.approverRoles],
    approverUserIds: [...step.approverUserIds],
    key: `${prefix}-${index}`,
  }));

const toChain = (steps: readonly DraftStep[]): ApprovalChain => ({
  steps: steps.map(({ key: _key, ...step }) => step),
});

const STEP_FIELD_MESSAGES: Readonly<Record<string, string>> = {
  name: "Give the step a name",
};

/**
 * Validation messages per step index, plus chain-level ones under -1: the schema's, then (once the
 * team has loaded) steps the team can't complete and approvers who have left.
 */
function issuesByStep(chain: ApprovalChain, team: readonly TeamMember[] | undefined) {
  const issues = new Map<number, string[]>();
  const add = (stepIndex: number, message: string) => {
    const list = issues.get(stepIndex) ?? [];
    if (!list.includes(message)) list.push(message);
    issues.set(stepIndex, list);
  };

  const result = ApprovalChain.safeParse(chain);
  for (const issue of result.error?.issues ?? []) {
    const [, index, field] = issue.path;
    add(
      typeof index === "number" ? index : -1,
      (typeof field === "string" && STEP_FIELD_MESSAGES[field]) || issue.message,
    );
  }
  if (team) {
    for (const [stepIndex, messages] of chainTeamIssues(chain, team)) {
      for (const message of messages) add(stepIndex, message);
    }
  }
  return issues;
}

const APPROVAL_OPTIONS = Array.from({ length: APPROVAL_STEP_MAX_APPROVALS }, (_, index) => ({
  value: String(index + 1),
  label: index === 0 ? "1 approval" : `${index + 1} approvals`,
}));

export function ApprovalChainEditor({
  client,
  readOnlyReason,
}: {
  client: ClientDto;
  readOnlyReason: string | null;
}) {
  const toast = useToast();
  const replace = useReplaceApprovalChain(client.id);
  const team = useTeamDirectory();
  const [saved, setSaved] = useState<ApprovalChain>(() => client.approvalChain);
  const [steps, setSteps] = useState<DraftStep[]>(() => toDraft(client.approvalChain, "saved"));
  const readOnly = readOnlyReason !== null;

  const chain = toChain(steps);
  const dirty = JSON.stringify(chain) !== JSON.stringify(saved);
  const issues = issuesByStep(chain, team.data);

  function updateStep(index: number, changes: Partial<ApprovalStep>) {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...changes } : step)));
  }

  function moveStep(index: number, delta: -1 | 1) {
    setSteps((current) => {
      const target = index + delta;
      const moving = current[index];
      const other = current[target];
      if (!moving || !other) return current;
      const next = [...current];
      next[index] = other;
      next[target] = moving;
      return next;
    });
  }

  function addStep() {
    setSteps((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        name: `Step ${current.length + 1}`,
        approverRoles: ["ADMIN"],
        approverUserIds: [],
        minApprovals: 1,
      },
    ]);
  }

  function save() {
    const parsed = ApprovalChain.safeParse(chain);
    if (!parsed.success || issues.size > 0) return;
    replace.mutate(parsed.data, {
      onSuccess: (next) => {
        setSaved(next.approvalChain);
        setSteps(toDraft(next.approvalChain, crypto.randomUUID()));
        toast.success(
          "Approval chain saved",
          "New approval requests follow it; ones already open keep theirs.",
        );
      },
    });
  }

  const chainIssues = issues.get(-1);

  return (
    <EditorForm onSubmit={save}>
      <EditorSection
        title="Sign-off"
        description={
          <>
            Every post walks these steps in order. A step completes once it collects its approvals;
            a change request at any step sends the post back to the agents. Approve-all never skips
            a step.
          </>
        }
      >
        <ChainSummary steps={steps} />

        <ol className="flex flex-col">
          {steps.map((step, index) => (
            <li key={step.key} className="flex flex-col">
              {index > 0 ? (
                <span
                  aria-hidden
                  className="ml-8 h-6 w-px bg-linear-to-b from-paper/5 via-paper/25 to-paper/5"
                />
              ) : null}
              <StepCard
                step={step}
                index={index}
                total={steps.length}
                readOnly={readOnly}
                issues={issues.get(index)}
                team={team.data}
                teamLoading={team.isPending}
                onChange={(changes) => updateStep(index, changes)}
                onMove={(delta) => moveStep(index, delta)}
                onRemove={() => setSteps((current) => current.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ol>

        {chainIssues ? <FieldError>{chainIssues.join(" ")}</FieldError> : null}

        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={addStep} disabled={steps.length >= APPROVAL_CHAIN_MAX_STEPS}>
              Add step
            </Button>
            <Button
              variant="ghost"
              onClick={() => setSteps(toDraft(defaultApprovalChain(), crypto.randomUUID()))}
            >
              Restore default
            </Button>
            <span className="font-mono text-[11px] text-steel/70">
              {steps.length} / {APPROVAL_CHAIN_MAX_STEPS} steps
            </span>
          </div>
        )}
      </EditorSection>

      <SaveBar
        dirty={dirty}
        saving={replace.isPending}
        invalid={issues.size > 0}
        error={
          issues.size > 0
            ? "Fix the highlighted steps to save."
            : replace.isError
              ? errorMessage(replace.error)
              : null
        }
        saveLabel="Save approval chain"
        onDiscard={() => setSteps(toDraft(saved, crypto.randomUUID()))}
        readOnlyReason={readOnlyReason}
      />
    </EditorForm>
  );
}

function ChainSummary({ steps }: { steps: readonly DraftStep[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-steel">
      <span className="text-paper/60">Draft</span>
      {steps.map((step) => (
        <span key={step.key} className="flex items-center gap-2">
          <span aria-hidden>→</span>
          <span className="text-paper/90">{step.name.trim() || "Untitled step"}</span>
        </span>
      ))}
      <span aria-hidden>→</span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full bg-enmo" />
        Approved
      </span>
    </p>
  );
}

interface StepCardProps {
  step: DraftStep;
  index: number;
  total: number;
  readOnly: boolean;
  issues?: string[];
  /** Everyone on the team; undefined while loading or if the directory couldn't be fetched. */
  team?: TeamMember[];
  teamLoading: boolean;
  onChange: (changes: Partial<ApprovalStep>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

function StepCard({
  step,
  index,
  total,
  readOnly,
  issues,
  team,
  teamLoading,
  onChange,
  onMove,
  onRemove,
}: StepCardProps) {
  const headingId = useId();
  const number = index + 1;

  function toggleRole(role: Role, checked: boolean) {
    const next = new Set(step.approverRoles);
    if (checked) next.add(role);
    else next.delete(role);
    onChange({ approverRoles: Role.options.filter((option) => next.has(option)) });
  }

  function toggleUser(userId: string, checked: boolean) {
    onChange({
      approverUserIds: checked
        ? [...step.approverUserIds, userId]
        : step.approverUserIds.filter((id) => id !== userId),
    });
  }

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={cx(
        "flex flex-col gap-6 rounded-xl border bg-panel p-5 transition-colors duration-200",
        issues ? "border-red-400/30" : "border-line",
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <h3 id={headingId} className="flex items-center gap-3">
          <span className="flex size-7 items-center justify-center rounded-full border border-line font-mono text-[11px] text-paper">
            {number}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-steel">
            Step {number}
          </span>
        </h3>
        {readOnly ? null : (
          <div className="flex items-center gap-1">
            <IconButton
              label={`Move step ${number} up`}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
            </IconButton>
            <IconButton
              label={`Move step ${number} down`}
              disabled={index === total - 1}
              onClick={() => onMove(1)}
            >
              <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
            </IconButton>
            <IconButton label={`Remove step ${number}`} disabled={total === 1} onClick={onRemove}>
              <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" />
            </IconButton>
          </div>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-[1fr_12rem]">
        <Input
          label="Step name"
          value={step.name}
          onChange={(event) => onChange({ name: event.target.value })}
          readOnly={readOnly}
          maxLength={80}
          placeholder="Manager review"
        />
        <Select
          label="Approvals needed"
          value={String(step.minApprovals)}
          onChange={(event) => onChange({ minApprovals: Number(event.target.value) })}
          options={APPROVAL_OPTIONS}
          disabled={readOnly}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-[12rem_1fr]">
        <fieldset disabled={readOnly} className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-xs font-medium tracking-wide text-steel">
            Approver roles
          </legend>
          {Role.options.map((role) => (
            <Checkbox
              key={role}
              label={ROLE_LABEL[role]}
              checked={step.approverRoles.includes(role)}
              onChange={(event) => toggleRole(role, event.target.checked)}
            />
          ))}
        </fieldset>

        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-2.5">
          <legend className="mb-2.5 text-xs font-medium tracking-wide text-steel">
            Named approvers
          </legend>
          <NamedApprovers
            selected={step.approverUserIds}
            team={team}
            loading={teamLoading}
            readOnly={readOnly}
            onToggle={toggleUser}
          />
        </fieldset>
      </div>

      {team ? <EligibleApprovers step={step} team={team} /> : null}

      {issues ? (
        <ul className="flex flex-col gap-1">
          {issues.map((message) => (
            <li key={message}>
              <FieldError>{message}</FieldError>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NamedApprovers({
  selected,
  team,
  loading,
  readOnly,
  onToggle,
}: {
  selected: readonly string[];
  team?: TeamMember[];
  loading: boolean;
  readOnly: boolean;
  onToggle: (userId: string, checked: boolean) => void;
}) {
  if (loading) return <Skeleton className="h-16 w-full" />;

  const none = (
    <span className="text-sm text-steel/70">None: anyone in the roles above can decide.</span>
  );

  if (!team) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        {selected.length === 0
          ? none
          : selected.map((userId) => (
              <Checkbox
                key={userId}
                label={<span className="font-mono text-xs">{userId}</span>}
                checked
                onChange={() => onToggle(userId, false)}
              />
            ))}
        <span className="text-xs text-steel/70">The team list couldn&apos;t be loaded.</span>
      </div>
    );
  }

  const known = new Set(team.map((member) => member.id));
  // Read-only viewers see who is named; writers pick from everyone who can still sign in.
  const listed = team.filter((member) =>
    readOnly ? selected.includes(member.id) : member.isActive || selected.includes(member.id),
  );
  const unknown = selected.filter((id) => !known.has(id));
  if (listed.length === 0 && unknown.length === 0) return none;

  return (
    <div className="flex max-h-56 flex-col gap-2.5 overflow-y-auto pr-1">
      {listed.map((member) => (
        <Checkbox
          key={member.id}
          label={member.name}
          description={`${ROLE_LABEL[member.role]}${member.isActive ? "" : " · deactivated"}`}
          checked={selected.includes(member.id)}
          onChange={(event) => onToggle(member.id, event.target.checked)}
        />
      ))}
      {unknown.map((userId) => (
        <Checkbox
          key={userId}
          label={<span className="font-mono text-xs">{userId}</span>}
          description="No longer on the team"
          checked
          onChange={() => onToggle(userId, false)}
        />
      ))}
    </div>
  );
}

const MAX_NAMES_SHOWN = 4;

/** Who could decide this step today, so a step nobody can complete is visible before saving. */
function EligibleApprovers({ step, team }: { step: ApprovalStep; team: readonly TeamMember[] }) {
  const eligible = eligibleApprovers(step, team);
  const names = eligible.slice(0, MAX_NAMES_SHOWN).map((member) => member.name);
  const more = eligible.length - names.length;
  return (
    <p
      className={cx(
        "font-mono text-[11px] tracking-[0.08em] uppercase",
        eligible.length < step.minApprovals ? "text-red-300" : "text-steel",
      )}
    >
      {eligible.length} eligible {eligible.length === 1 ? "approver" : "approvers"}
      {names.length > 0 ? (
        <span className="normal-case tracking-normal text-steel">
          {" · "}
          {names.join(", ")}
          {more > 0 ? ` and ${more} more` : ""}
        </span>
      ) : null}
    </p>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-steel transition duration-200 ease-enmo hover:bg-paper/[0.06] hover:text-paper disabled:pointer-events-none disabled:opacity-30"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}
