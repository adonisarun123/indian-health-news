import type { Metadata } from "next";
import { HubPage, type HubProps, hubMetadata } from "@/components/HubPage";

export function generateMetadata(props: HubProps): Promise<Metadata> {
  return hubMetadata("topic", props);
}

export default function Page(props: HubProps) {
  return <HubPage kind="topic" {...props} />;
}
