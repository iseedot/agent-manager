import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { factStyle, type FactTone, type StyleMap } from "./styles";
import { SwipeRow, type SwipeAction } from "./swipe";

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
  swipe,
}: {
  rows: TreeRow[];
  selectedKey: string | null;
  onSelect: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  styles: StyleMap;
  compact: boolean;
  emptyText: string;
  swipe?: {
    enabled: boolean;
    openKey: string | null;
    setOpenKey: (key: string | null) => void;
    actionWidth: number;
    actionsFor: (row: TreeRow) => SwipeAction[];
  };
}) {
  const [swiping, setSwiping] = useState(false);
  return (
    <ScrollView
      style={styles.paneScroll}
      contentContainerStyle={styles.paneContent}
      scrollEnabled={!swiping}
    >
      {rows.length === 0 ? <Text style={styles.empty}>{emptyText}</Text> : null}
      {rows.map((row) => {
        const selected = row.key === selectedKey;
        const group = row.kind === "project" || row.kind === "orphan";
        const spacing = group ? styles.swipeWrapProject : null;
        const rowNode = (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityState={{ selected, expanded: row.expandable ? row.expanded : undefined }}
            onPress={() => onSelect(row)}
            style={[
              styles.treeRow,
              group ? styles.treeRowProject : styles.treeRowNested,
              selected ? styles.treeRowSelected : null,
              row.archived ? styles.treeRowArchived : null,
            ]}
          >
            <View style={styles.treeRowBody}>
              {row.expandable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={row.expanded ? "Collapse" : "Expand"}
                  hitSlop={compact ? 14 : 8}
                  onPress={() => onToggle(row)}
                  style={[styles.treeBar, group ? styles.treeBarProject : styles.treeBarWorkspace]}
                >
                  <Text
                    style={[
                      styles.treeBarLabel,
                      group ? styles.treeBarLabelProject : styles.treeBarLabelWorkspace,
                    ]}
                  >
                    {row.expanded ? "▼" : "▶"}
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.treeBarSpacer} />
              )}
              <View style={styles.treeRowContent}>
                <View style={styles.treeRowInner}>
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
                        {index === 0 ? fact.text : ` · ${fact.text}`}
                      </Text>
                    ))}
                  </Text>
                ) : null}
              </View>
            </View>
          </Pressable>
        );
        if (!swipe?.enabled) {
          return (
            <View key={row.key} style={spacing}>
              {rowNode}
            </View>
          );
        }
        return (
          <SwipeRow
            key={row.key}
            enabled={swipe.enabled}
            actions={swipe.actionsFor(row)}
            actionWidth={swipe.actionWidth}
            open={swipe.openKey === row.key}
            onOpenChange={(open) => swipe.setOpenKey(open ? row.key : null)}
            onActiveChange={setSwiping}
            styles={styles}
            wrapStyle={spacing}
          >
            {rowNode}
          </SwipeRow>
        );
      })}
    </ScrollView>
  );
}
