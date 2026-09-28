import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { browseRpc, readFileRpc, type BrowseEntry } from "../shared/contracts";
import { message } from "./format";

interface OpenFile {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
}

const MAX_ROWS = 600;

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`;
  }
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) {
    return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
  }
  return `${(megabytes / 1024).toFixed(2)} GB`;
}

export function HomeExplorerPanel({ theme, layout }: PluginHostProps) {
  const browse = useRpc(browseRpc);
  const readFile = useRpc(readFileRpc);
  const compact = layout.compact;

  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const listing = useQuery({
    queryKey: ["agent-manager", "browse", path ?? "~"],
    queryFn: () => browse({ path }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const data = listing.data;
  const entries = useMemo(() => (data?.entries ?? []).slice(0, MAX_ROWS), [data?.entries]);

  const styles = useMemo(() => {
    const palette = theme.colors;
    return {
      screen: { flex: 1, backgroundColor: palette.surface0, padding: compact ? 10 : 14 },
      pathRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingBottom: 6,
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
      },
      path: { color: palette.foreground, fontSize: 11, flexShrink: 1 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: compact ? 8 : 6,
        borderTopWidth: 1,
        borderTopColor: palette.border,
      },
      rowName: { color: palette.foreground, fontSize: 13, flexShrink: 1 },
      rowDir: { color: palette.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 },
      rowMeta: { color: palette.foregroundMuted, fontSize: 11, marginLeft: "auto" as const },
      error: { color: palette.statusDanger, fontSize: 12, lineHeight: 17, marginTop: 8 },
      note: { color: palette.foregroundMuted, fontSize: 11, lineHeight: 16, marginTop: 8 },
      fileHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingBottom: 6,
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
      },
      fileHeadText: { color: palette.foreground, fontSize: 11, flexShrink: 1 },
      back: { paddingHorizontal: 8, paddingVertical: 2 },
      backText: { color: palette.foregroundMuted, fontSize: 12 },
      fileBody: {
        color: palette.foreground,
        fontSize: 12,
        lineHeight: 17,
        backgroundColor: palette.surface1,
        borderRadius: 8,
        padding: compact ? 8 : 12,
        marginTop: 8,
        borderWidth: 1,
        borderColor: palette.border,
      },
      empty: { color: palette.foregroundMuted, fontSize: 13, paddingVertical: 16 },
    };
  }, [theme, compact]);

  const goTo = useCallback((next: string) => {
    setFileError(null);
    setPreview(null);
    setPath(next);
  }, []);

  const openFile = useCallback(
    (target: string) => {
      setFileError(null);
      setLoadingFile(true);
      void (async () => {
        try {
          const file = await readFile({ path: target });
          if (file.error) {
            setFileError(`${target}: ${file.error}`);
            return;
          }
          setPreview({ path: file.path, text: file.text, size: file.size, truncated: file.truncated });
        } catch (error) {
          setFileError(message(error));
        } finally {
          setLoadingFile(false);
        }
      })();
    },
    [readFile],
  );

  if (listing.isLoading && !data) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const currentPath = data?.path ?? path ?? "";
  const parent = data?.parent ?? null;

  if (preview) {
    return (
      <View style={styles.screen}>
        <View style={styles.fileHead}>
          <Text style={styles.fileHeadText} numberOfLines={2}>
            {preview.path}
          </Text>
          <Pressable accessibilityRole="button" style={styles.back} onPress={() => setPreview(null)}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }}>
          <Text style={styles.fileBody} selectable>
            {preview.text.length > 0 ? preview.text : "(empty file)"}
          </Text>
          {preview.truncated ? (
            <Text style={styles.note}>Showing the first 256 KB of {formatSize(preview.size)} in total.</Text>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.pathRow}>
        <Text style={styles.path} numberOfLines={2}>
          {currentPath}
        </Text>
        {listing.isFetching || loadingFile ? (
          <ActivityIndicator color={theme.colors.accent} size="small" />
        ) : null}
      </View>
      <ScrollView>
        {parent ? (
          <Pressable accessibilityRole="button" style={styles.row} onPress={() => goTo(parent)}>
            <Text style={styles.rowDir} numberOfLines={1}>
              ../
            </Text>
          </Pressable>
        ) : null}
        {entries.map((entry) => (
          <Pressable
            key={entry.path}
            accessibilityRole="button"
            style={styles.row}
            onPress={() => (entry.directory ? goTo(entry.path) : openFile(entry.path))}
          >
            <Text style={entry.directory ? styles.rowDir : styles.rowName} numberOfLines={1}>
              {entry.directory ? `${entry.name}/` : entry.name}
              {entry.link ? " →" : ""}
            </Text>
            <Text style={styles.rowMeta}>{entry.directory ? "" : formatSize(entry.size)}</Text>
          </Pressable>
        ))}
        {entries.length === 0 && !data?.error ? <Text style={styles.empty}>Nothing here.</Text> : null}
        {data?.error ? <Text style={styles.error}>{data.error}</Text> : null}
        {fileError ? <Text style={styles.error}>{fileError}</Text> : null}
        {listing.isError ? <Text style={styles.error}>{message(listing.error)}</Text> : null}
      </ScrollView>
    </View>
  );
}
