import { EventLinkResult, SwitchWithoutLinks } from "./event-link-result";
import type { GroupEventLinkSummary } from "../../../workers/shared/event-link-preload";
import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Directory, Mode } from "../../../workers/shared/types";
import { MODES } from "../../../workers/shared/types";
import { Card, Checkbox, Code, Flex, Select, Table, Text, TextField } from "@radix-ui/themes";
import * as EmptyState from "../../ui/empty-state";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { ModeBadge } from "./ui";

type SortKey = "name" | "mode" | "created_at";
type SortDir = "asc" | "desc";
type BulkResult = {
  bulkUpdated?: number;
  bulkMode?: string;
  error?: string;
  cutovers?: { directory_id: string; name: string; summary: GroupEventLinkSummary }[];
};

const PAGE_SIZES = [25, 50, 100];

/** Searchable, filterable, sortable, paged list of directories with multi-select
 *  bulk mode changes. Client-side — a few hundred rows fit in one loader payload,
 *  so filtering/selection happen in memory; only the bulk mode change POSTs. */
export function DirectoryTable({
  directories,
  diverged,
  demoDirectory,
}: {
  directories: Directory[];
  /** Resources WorkOS holds a write for that native does not, by directory id.
   *  Absent means none. */
  diverged: Record<string, number>;
  /** The directory the bundled simulators drive — badged so an operator can tell
   *  it from their own imports. Null (or absent) outside demo mode. */
  demoDirectory?: string | null;
}) {
  const fetcher = useFetcher<BulkResult>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | Mode>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState("");
  const [override, setOverride] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = directories.filter((d) => {
      if (mode !== "all" && d.mode !== mode) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
    });
    rows.sort((a, b) => {
      const cmp =
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : a[sortKey] < b[sortKey]
            ? -1
            : a[sortKey] > b[sortKey]
              ? 1
              : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [directories, query, mode, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(current * pageSize, current * pageSize + pageSize);

  const filteredIds = useMemo(() => filtered.map((d) => d.id), [filtered]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const someSelected = filteredIds.some((id) => selected.has(id));
  const headerChecked: boolean | "indeterminate" = allSelected
    ? true
    : someSelected
      ? "indeterminate"
      : false;

  // Clear the selection once a bulk change lands (the loader has revalidated).
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bulkUpdated && !fetcher.data.error) {
      setSelected(new Set());
      setBulkMode("");
      setOverride(false);
    }
  }, [fetcher.state, fetcher.data]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyBulk() {
    if (!bulkMode || selected.size === 0) return;
    fetcher.submit(
      {
        intent: "bulk-set-mode",
        mode: bulkMode,
        ids: [...selected].join(","),
        switch_without_links: override ? "on" : "",
      },
      { method: "post" },
    );
  }

  function applyBulkLog(on: boolean) {
    if (selected.size === 0) return;
    fetcher.submit(
      { intent: "bulk-set-log-persistence", on: String(on), ids: [...selected].join(",") },
      { method: "post" },
    );
  }

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "");

  if (directories.length === 0) {
    return (
      <Card size="3">
        <EmptyState.Root
          title="No directories yet"
          subtitle="Import a directory to mint the proxy token the IdP will authenticate with — or to bring the one it already presents."
        />
      </Card>
    );
  }

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="3" justify="between" wrap="wrap">
          <Flex align="center" gap="3" wrap="wrap">
            <TextField.Root
              aria-label="Search directories"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Search name or id"
              style={{ minWidth: 260 }}
              value={query}
            />
            <Select.Root
              onValueChange={(v) => {
                setMode(v as "all" | Mode);
                setPage(0);
              }}
              value={mode}
            >
              <Select.Trigger aria-label="Filter by mode" />
              <Select.Content>
                <Select.Item value="all">All modes</Select.Item>
                {MODES.map((m) => (
                  <Select.Item key={m} value={m}>
                    {m}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
          <Flex align="center" gap="3">
            {fetcher.data?.bulkUpdated ? (
              <Text color="green" size="2">
                Set {fetcher.data.bulkUpdated} to {fetcher.data.bulkMode}
              </Text>
            ) : null}
            <Text color="gray" size="2">
              {filtered.length} of {directories.length}
            </Text>
          </Flex>
        </Flex>

        {selected.size > 0 && (
          <Flex
            align="center"
            gap="3"
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-3)",
              background: "var(--gray-a3)",
            }}
            wrap="wrap"
          >
            <Text size="2" weight="medium">
              {selected.size} selected
            </Text>
            <Select.Root onValueChange={setBulkMode} value={bulkMode}>
              <Select.Trigger aria-label="Target mode" placeholder="Set mode to…" />
              <Select.Content>
                {MODES.map((m) => (
                  <Select.Item key={m} value={m}>
                    {m}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {bulkMode === "workos-only" && (
              <SwitchWithoutLinks checked={override} onCheckedChange={setOverride} />
            )}
            <Button
              variant="solid"
              disabled={!bulkMode}
              loading={fetcher.state !== "idle"}
              onClick={applyBulk}
            >
              Apply
            </Button>
            <Button color="green" onClick={() => applyBulkLog(true)} variant="soft">
              Monitor
            </Button>
            <Button onClick={() => applyBulkLog(false)} variant="soft">
              Stop monitoring
            </Button>
            <Button onClick={() => setSelected(new Set())} variant="soft">
              Clear
            </Button>
            {fetcher.data?.error ? (
              <Text color="red" size="2">
                {fetcher.data.error}
              </Text>
            ) : null}
          </Flex>
        )}

        {fetcher.data?.cutovers?.map((result) => (
          <Flex key={result.directory_id} direction="column" gap="2">
            <Text weight="medium" size="2">
              {result.name} ({result.directory_id})
            </Text>
            <EventLinkResult summary={result.summary} />
          </Flex>
        ))}

        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>
                <Checkbox
                  aria-label="Select all filtered directories"
                  checked={headerChecked}
                  onCheckedChange={toggleAll}
                />
              </Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>
                <SortButton
                  label="Name"
                  indicator={arrow("name")}
                  onClick={() => toggleSort("name")}
                />
              </Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Directory id</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>
                <SortButton
                  label="Mode"
                  indicator={arrow("mode")}
                  onClick={() => toggleSort("mode")}
                />
              </Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>
                <SortButton
                  label="Created"
                  indicator={arrow("created_at")}
                  onClick={() => toggleSort("created_at")}
                />
              </Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Native</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Logs</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pageRows.map((d) => (
              <Table.Row key={d.id}>
                <Table.Cell>
                  <Checkbox
                    aria-label={`Select ${d.name}`}
                    checked={selected.has(d.id)}
                    onCheckedChange={() => toggleOne(d.id)}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Flex align="center" display="inline-flex" gap="2">
                    <Link to={`/panel/directories/${d.id}`}>{d.name}</Link>
                    {d.id === demoDirectory && (
                      <Badge color="amber" variant="soft">
                        Demo
                      </Badge>
                    )}
                  </Flex>
                </Table.Cell>
                <Table.Cell>
                  <Code size="1">{d.id}</Code>
                </Table.Cell>
                <Table.Cell>
                  <ModeBadge mode={d.mode} />
                </Table.Cell>
                <Table.Cell>
                  <Text color="gray" size="1" style={{ whiteSpace: "nowrap" }}>
                    {d.created_at}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  {diverged[d.id] ? (
                    <Link to={`/panel/directories/${d.id}`}>
                      <Badge color="red">{diverged[d.id]} diverged</Badge>
                    </Link>
                  ) : (
                    <Badge color="gray" variant="soft">
                      current
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {d.log_persistence ? (
                    <Badge color="green">Monitored</Badge>
                  ) : (
                    <Badge color="gray" variant="soft">
                      Off
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Button asChild size="1" type={null} variant="soft">
                    <Link to={`/panel/directories/${d.id}`}>Open</Link>
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>

        {filtered.length === 0 && (
          <Text color="gray" size="2">
            No directories match “{query}”{mode !== "all" ? ` in ${mode}` : ""}.
          </Text>
        )}

        <Flex align="center" gap="3" justify="between" wrap="wrap">
          <Flex align="center" gap="2">
            <Text color="gray" size="1">
              Rows per page
            </Text>
            <Select.Root
              onValueChange={(v) => {
                setPageSize(Number(v));
                setPage(0);
              }}
              value={String(pageSize)}
            >
              <Select.Trigger aria-label="Rows per page" />
              <Select.Content>
                {PAGE_SIZES.map((s) => (
                  <Select.Item key={s} value={String(s)}>
                    {s}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
          <Flex align="center" gap="3">
            <Text color="gray" size="2">
              Page {current + 1} of {pageCount}
            </Text>
            <Button disabled={current === 0} onClick={() => setPage(current - 1)} variant="soft">
              Previous
            </Button>
            <Button
              disabled={current >= pageCount - 1}
              onClick={() => setPage(current + 1)}
              variant="soft"
            >
              Next
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
}

function SortButton({
  label,
  indicator,
  onClick,
}: {
  label: string;
  indicator: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: "pointer",
        background: "transparent",
        border: 0,
        padding: 0,
        font: "inherit",
        color: "inherit",
      }}
      type="button"
    >
      {label}
      {indicator}
    </button>
  );
}
