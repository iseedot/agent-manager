import { Pressable, ScrollView, Text, View } from "react-native";

import { factStyle, statusDotStyle, treeMetrics, type FactTone, type StyleMap } from "./styles";

export type TreeKind = "project" | "workspace" | "agent" | "orphan";

export interface TreeRow {
  key: string;
  kind: TreeKind;
  id: string;
  workspaceId: string | null;
  label: string;
  facts: Array<{ text: string; tone: FactTone }>;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  archived: boolean;
  status: string | null;
  count: number | null;
}

export function TreePane({
  rows,
  selectedKey,
  onSelect,
  onToggle,
  styles,
  compact,
  emptyText,
}: {
  rows: TreeRow[];
  selectedKey: string | null;
  onSelect: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  styles: StyleMap;
  compact: boolean;
  emptyText: string;
}) {
  const { marker, titleOffset } = treeMetrics(compact);
  return (
    <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneContent}>
      {rows.length === 0 ? <Text style={styles.empty}>{emptyText}</Text> : null}
      {rows.map((row) => {
        const selected = row.key === selectedKey;
        const group = row.kind === "project" || row.kind === "orphan";
        return (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityState={{ selected, expanded: row.expandable ? row.expanded : undefined }}
            onPress={() => onSelect(row)}
            style={[
              styles.treeRow,
              group ? styles.treeRowProject : null,
              selected ? styles.treeRowSelected : null,
              row.archived ? styles.treeRowArchived : null,
            ]}
          >
            {group ? (
              <View style={[styles.treeStripe, row.archived ? styles.treeStripeMuted : styles.treeStripeProject]} />
            ) : row.kind === "workspace" ? (
              <View style={[styles.treeStripeWorkspace, row.archived ? styles.treeStripeMuted : null]} />
            ) : null}
            <View style={styles.treeRowInner}>
              {row.expandable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={row.expanded ? "Collapse" : "Expand"}
                  hitSlop={compact ? 12 : 6}
                  onPress={() => onToggle(row)}
                  style={[styles.treeChevron, compact ? styles.treeChevronTap : null]}
                >
                  <Text style={styles.treeChevronText}>{row.expanded ? "▼" : "▶"}</Text>
                </Pressable>
              ) : (
                <View style={styles.treeChevronSpacer} />
              )}
              {row.kind === "agent" ? (
                <View style={[styles.treeDot, statusDotStyle(row.status ?? "closed", styles)]} />
              ) : (
                <View style={{ width: marker, height: marker }} />
              )}
              <Text
                style={[
                  styles.treeLabel,
                  row.kind === "workspace" ? styles.treeLabelWorkspace : null,
                  row.kind === "agent" ? styles.treeLabelAgent : null,
                  group ? styles.treeLabelProject : null,
                  row.archived ? styles.treeLabelArchived : null,
                ]}
                numberOfLines={1}
              >
                {row.label}
              </Text>
              {row.count !== null ? (
                <View style={styles.treeCountBadge}>
                  <Text style={styles.treeCountText}>{row.count}</Text>
                </View>
              ) : null}
            </View>
            {row.facts.length > 0 ? (
              <Text style={[styles.treeFacts, { paddingLeft: titleOffset }]} numberOfLines={2}>
                {row.facts.map((fact, index) => (
                  <Text key={`${row.key}-${fact.text}`} style={factStyle(fact.tone, styles)}>
                    {index === 0 ? fact.text : ` · ${fact.text}`}
                  </Text>
                ))}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
