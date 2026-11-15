import { notFound } from "next/navigation";
import { orgsEnabled } from "../../lib/features";
import WorkspaceApp from "./WorkspaceApp";

export const metadata = { title: "AIMO BRAIN — Organization workspace (sandbox)" };
export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  if (!orgsEnabled()) notFound();
  return <WorkspaceApp />;
}
