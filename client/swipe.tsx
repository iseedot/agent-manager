import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import type { ComponentProps } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";
import type { View as RNView } from "react-native";

import type { StyleMap } from "./styles";

export interface SwipeAction {
  id: string;
  label: string;
  tone: "default" | "primary" | "danger";
  disabled?: boolean;
  run: () => void;
}

type ViewStyleProp = ComponentProps<typeof RNView>["style"];

const ACTIVATE_PX = 14;
const HORIZONTAL_RATIO = 1.8;
const OPEN_FRACTION = 0.34;
const OVERSWIPE_PX = 96;
const OVERSWIPE_FRICTION = 0.4;
const TRIGGER_PX = 40;

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
  const armed = useRef(new Animated.Value(0)).current;
  const openRef = useRef(open);
  openRef.current = open;
  const widthRef = useRef(width);
  widthRef.current = width;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: open ? -width : 0,
      duration: 150,
      useNativeDriver: false,
    }).start();
  }, [open, width, translateX]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          enabled &&
          actionsRef.current.length > 0 &&
          Math.abs(gesture.dx) > ACTIVATE_PX &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * HORIZONTAL_RATIO,
        onPanResponderGrant: () => onActiveChange?.(true),
        onPanResponderMove: (_event, gesture) => {
          const drawn = offsetFor(openRef.current ? -widthRef.current : 0, gesture.dx, widthRef.current);
          translateX.setValue(drawn);
          armed.setValue(Math.min(1, Math.max(0, (-drawn - widthRef.current) / TRIGGER_PX)));
        },
        onPanResponderRelease: (_event, gesture) => {
          const drawn = offsetFor(openRef.current ? -widthRef.current : 0, gesture.dx, widthRef.current);
          const past = -drawn - widthRef.current;
          armed.setValue(0);
          onActiveChange?.(false);
          if (past >= TRIGGER_PX) {
            onOpenChange(false);
            fireEdgeAction(actionsRef.current);
            return;
          }
          onOpenChange(drawn < -widthRef.current * OPEN_FRACTION);
        },
        onPanResponderTerminate: () => {
          armed.setValue(0);
          onOpenChange(openRef.current);
          onActiveChange?.(false);
        },
      }),
    [enabled, translateX, armed, onOpenChange, onActiveChange],
  );

  if (!enabled || actions.length === 0) {
    return <View style={wrapStyle}>{children}</View>;
  }

  const edgeIndex = actions.length - 1;
  const edgeScale = armed.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });

  return (
    <View style={wrapStyle}>
      <View style={styles.swipeTrack}>
        <View style={[styles.swipeStrip, { width }]}>
          {actions.map((action, index) => {
            const block = (
              <Pressable
                accessibilityRole="button"
                disabled={action.disabled === true}
                style={[
                  styles.swipeAction,
                  styles.swipeActionFill,
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
            );
            return index === edgeIndex ? (
              <Animated.View key={action.id} style={{ width: actionWidth, transform: [{ scale: edgeScale }] }}>
                {block}
              </Animated.View>
            ) : (
              <View key={action.id} style={{ width: actionWidth }}>
                {block}
              </View>
            );
          })}
        </View>
        <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX }] }}>
          {children}
        </Animated.View>
      </View>
    </View>
  );
}

function offsetFor(base: number, dx: number, width: number): number {
  const raw = base + dx;
  if (raw >= -width) {
    return Math.max(-width, Math.min(0, raw));
  }
  const past = -width - raw;
  return -width - Math.min(OVERSWIPE_PX, past * OVERSWIPE_FRICTION);
}

function fireEdgeAction(actions: SwipeAction[]): void {
  const edge = actions[actions.length - 1];
  if (edge && edge.disabled !== true) {
    edge.run();
  }
}
