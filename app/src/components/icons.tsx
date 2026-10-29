// Small icons drawn with Views so the app needs no icon or SVG dependency.
// All are decorative: the control that holds one carries the accessible label.
import { StyleSheet, View } from 'react-native';

export function CheckIcon({ color, size = 12 }: { color: string; size?: number }) {
  return (
    <View
      accessible={false}
      aria-hidden
      style={{
        width: size * 0.5,
        height: size,
        borderRightWidth: 2,
        borderBottomWidth: 2,
        borderColor: color,
        transform: [{ rotate: '45deg' }, { translateY: -size * 0.1 }],
      }}
    />
  );
}

export function MicIcon({ color }: { color: string }) {
  return (
    <View accessible={false} aria-hidden style={styles.micWrap}>
      <View style={[styles.micHead, { backgroundColor: color }]} />
      <View style={[styles.micCup, { borderColor: color }]} />
      <View style={[styles.micStem, { backgroundColor: color }]} />
    </View>
  );
}

export function MoonIcon({ color, cutout }: { color: string; cutout: string }) {
  return (
    <View accessible={false} aria-hidden style={styles.moonWrap}>
      <View style={[styles.moon, { backgroundColor: color }]} />
      <View style={[styles.moonCut, { backgroundColor: cutout }]} />
    </View>
  );
}

/** A gear: a ring with a hub and four bars through it. Decorative; the button carries the label. */
export function GearIcon({ color, cutout }: { color: string; cutout: string }) {
  return (
    <View accessible={false} aria-hidden style={styles.gearWrap}>
      {[0, 45, 90, 135].map((deg) => (
        <View key={deg} style={[styles.gearBar, { backgroundColor: color, transform: [{ rotate: `${deg}deg` }] }]} />
      ))}
      <View style={[styles.gearRing, { backgroundColor: color }]} />
      <View style={[styles.gearHole, { backgroundColor: cutout }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  micWrap: { width: 22, height: 28, alignItems: 'center' },
  micHead: { width: 10, height: 16, borderRadius: 5 },
  micCup: {
    position: 'absolute',
    top: 8,
    width: 18,
    height: 13,
    borderWidth: 2,
    borderTopWidth: 0,
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
  },
  micStem: { position: 'absolute', bottom: 2, width: 2, height: 6, borderRadius: 1 },
  gearWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  gearBar: { position: 'absolute', width: 22, height: 5, borderRadius: 2 },
  gearRing: { position: 'absolute', width: 16, height: 16, borderRadius: 8 },
  gearHole: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  moonWrap: { width: 20, height: 20 },
  moon: { position: 'absolute', width: 18, height: 18, borderRadius: 9, top: 1, left: 1 },
  moonCut: { position: 'absolute', width: 15, height: 15, borderRadius: 7.5, top: -2, left: 7 },
});
