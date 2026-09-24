import { AGENT_LABEL, AgentName, type ClientDto } from "@enmo/shared";
import Link from "next/link";
import { AgentAvatar } from "@/components/agent/AgentAvatar";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

/*
 * The Command Center's empty state (MASTER_PLAN §04): the seven agents standing by, one line, one
 * green call to action. Scoped to a client when one is selected.
 */

export function ArsenalIdle({
  client,
  noActiveClients,
}: {
  client?: Pick<ClientDto, "id" | "name">;
  /**
   * The roster has no active client and the viewer may create one: offer that as a quiet
   * secondary path, without claiming there are no clients when some are archived.
   */
  noActiveClients?: { archived: number };
}) {
  const briefHref = client ? `/brief?clientId=${encodeURIComponent(client.id)}` : "/brief";

  return (
    <EmptyState
      eyebrow={client ? client.name : "All clients"}
      title={
        <>
          The Arsenal is idle. <span className="text-steel">Give it a brief.</span>
        </>
      }
      description={
        client
          ? `Tell the Manager what ${client.name} needs. It asks one question at most, plans the campaign for your approval, and nothing ships without it.`
          : "Tell the Manager what a client needs. It asks one question at most, plans the campaign for your approval, and nothing ships without it."
      }
      visual={
        <ul
          aria-label="The Arsenal, standing by"
          className="flex flex-wrap items-start justify-center gap-5"
        >
          {AgentName.options.map((agent) => (
            <li key={agent} className="flex w-16 flex-col items-center gap-2.5">
              <AgentAvatar agent={agent} size="lg" />
              <span className="font-mono text-[10px] leading-tight tracking-[0.12em] text-steel/80 uppercase">
                {AGENT_LABEL[agent]}
              </span>
            </li>
          ))}
        </ul>
      }
      action={
        <ButtonLink href={briefHref} variant="primary" size="lg">
          Start a brief
        </ButtonLink>
      }
    >
      {noActiveClients ? (
        <>
          {noActiveClients.archived === 0
            ? "No clients yet."
            : `No active clients (${noActiveClients.archived} archived).`}{" "}
          <Link
            href="/clients"
            className="text-paper underline decoration-paper/30 underline-offset-4 transition-colors duration-200 hover:decoration-paper"
          >
            {noActiveClients.archived === 0 ? "Add the first brand" : "Add a brand"}
          </Link>{" "}
          so the Arsenal knows its voice.
        </>
      ) : null}
    </EmptyState>
  );
}
