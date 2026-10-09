import { Callout, Checkbox, Flex, Text } from "@radix-ui/themes";
import type { GroupEventLinkSummary } from "../../../workers/shared/event-link-preload";

export function EventLinkResult({ summary }: { summary: GroupEventLinkSummary }) {
  return (
    <Flex direction="column" gap="2">
      <Text size="2">
        Event links: {summary.total} total, {summary.newly_linked} newly linked,{" "}
        {summary.already_linked} already linked, {summary.gone} gone.
      </Text>
      {summary.skipped && (
        <Text size="2">
          Bundled simulator: preload and cutover link checks are skipped; mock events use SCIM ids.
        </Text>
      )}
      {summary.reason && (
        <Callout.Root color="red">
          <Callout.Text>
            Preload incomplete: {summary.reason}. Live group coverage is unknown.
          </Callout.Text>
        </Callout.Root>
      )}
      {summary.failed.map((group) => (
        <Text key={group.dsync_id} color="red" size="2">
          {group.name || "Unnamed group"} ({group.dsync_id}): {group.reason}
        </Text>
      ))}
    </Flex>
  );
}

export function SwitchWithoutLinks({
  checked,
  onCheckedChange,
}: {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <Text as="label" size="2">
      <Flex gap="2" align="start">
        <Checkbox
          name="switch_without_links"
          checked={checked}
          onCheckedChange={onCheckedChange ? (value) => onCheckedChange(value === true) : undefined}
        />
        Switch without links (emergency override). Unresolved group events can fail or halt the
        listener. This override logs a warning.
      </Flex>
    </Text>
  );
}
