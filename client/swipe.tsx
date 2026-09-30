import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";

import type { ComponentProps } from "react";
import type { View as RNView } from "react-native";

import type { StyleMap } from "./styles";

type ViewStyleProp = ComponentProps<typeof RNView>["style"];

export interface SwipeAction {
  id: string;
  label: string;
  tone: "default" | "primary" | "danger";
  disabled?: boolean;
  run: () => void;
}

const ACTIVATE_PX = 14;
const HORIZONTAL_RATIO = 1.8;
const OPEN_FRACTION = 0.34;

export function SwipeRow({
  enabled,
  actions,
  actionWidth,
  open,
  onOpenChange,
  onActiveChange,
  styles,
  wrapStyle,
  children,
}: {
  enabled: boolean;
  actions: SwipeAction[];
  actionWidth: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActiveChange?: (active: boolean) => void;
  styles: StyleMap;
  wrapStyle?: ViewStyleProp;
  children: ReactNode;
}) {
  const width = actions.length * actionWidth;
  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef(open);
  openRef.current = open;
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: open ? -width : 0,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [open, width, translateX]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          enabled &&
          actions.length > 0 &&
          Math.abs(gesture.dx) > ACTIVATE_PX &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * HORIZONTAL_RATIO,
        onPanResponderGrant: () => onActiveChange?.(true),
        onPanResponderMove: (_event, gesture) => {
          const base = openRef.current ? -widthRef.current : 0;
          translateX.setValue(Math.min(0, Math.max(-widthRef.current, base + gesture.dx)));
        },
        onPanResponderRelease: (_event, gesture) => {
          const base = openRef.current ? -widthRef.current : 0;
          onOpenChange(base + gesture.dx < -widthRef.current * OPEN_FRACTION);
          onActiveChange?.(false);
        },
        onPanResponderTerminate: () => {
          onOpenChange(openRef.current);
          onActiveChange?.(false);
        },
      }),
    [enabled, actions.length, translateX, onOpenChange, onActiveChange],
  );

  if (!enabled || actions.length === 0) {
    return <View style={wrapStyle}>{children}</View>;
  }

  return (
    <View style={wrapStyle}>
      <View style={styles.swipeTrack}>
        <View style={[styles.swipeStrip, { width }]}>
          {actions.map((action, index) => (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              disabled={action.disabled === true}
              style={[
                styles.swipeAction,
                { width: actionWidth },
                index === 0 ? styles.swipeActionFirst : null,
                action.tone === "primary" ? styles.swipeActionPrimary : null,
                action.disabled === true ? styles.swipeActionDisabled : null,
              ]}
              onPress={() => {
                onOpenChange(false);
                action.run();
              }}
            >
              <Text
                style={action.tone === "default" ? styles.swipeActionText : styles.swipeActionTextOn}
                numberOfLines={2}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX }] }}>
          {children}
        </Animated.View>
      </View>
    </View>
  );
}
