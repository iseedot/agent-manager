import { Pressable, ScrollView, Text, View } from "react-native";

import { factStyle, statusDotStyle, type FactTone, type StyleMap } from "./styles";

export type TreeKind = "project" | "workspace" | "agent" | "orphan";

export interface TreeRow {
  key: string;
  kind: TreeKind;
  id: string;
  workspaceId: string | null;
  label: string;
  sub: string | null;
  facts: Array<{ text: string; tone: FactTone }>;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  archived: boolean;
  status: string | null;
  count: number | null;
}

const GUIDE_INSET = 4;

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
  const indent = compact ? 22 : 16;
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
            ) : null}
            {Array.from({ length: row.depth }).map((_, index) => (
              <View
                key={`guide-${index}`}
                style={[styles.treeGuide, { left: 8 + index * indent + GUIDE_INSET }]}
              />
            ))}
            <View style={[styles.treeRowInner, { paddingLeft: row.depth * indent }]}>
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
              {row.status ? (
                <View style={[styles.treeDot, statusDotStyle(row.status, styles)]} />
              ) : (
                <View style={styles.treeDot} />
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
              <Text style={styles.treeFacts} numberOfLines={2}>
                {row.facts.map((fact, index) => (
                  <Text key={`${row.key}-${fact.text}`} style={factStyle(fact.tone, styles)}>
                    {index === 0 ? `   ${fact.text}` : ` · ${fact.text}`}
                  </Text>
                ))}
              </Text>
            ) : null}
            {row.sub ? (
              <Text style={styles.treeSub} numberOfLines={1}>
                {`   ${row.sub}`}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
