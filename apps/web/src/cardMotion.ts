type MotionPoint<Channel extends string> = { offset: number } & Record<Channel, number>;

// Continuous tangents remove the pauses between poses. Sampling happens once;
// the browser runs the resulting transform animation on its compositor.
export function sampleCardMotion<Channel extends string>(points: readonly MotionPoint<Channel>[], channels: readonly Channel[]): MotionPoint<Channel>[] {
  const first = points[0].offset, last = points[points.length - 1].offset;
  return Array.from({ length: 91 }, (_, frame) => {
    const offset = frame === 90 ? last : first + (last - first) * frame / 90;
    const end = Math.max(1, points.findIndex(point => point.offset >= offset));
    const start = end - 1, from = points[start], to = points[end];
    const before = points[Math.max(0, start - 1)], after = points[Math.min(points.length - 1, end + 1)];
    const span = to.offset - from.offset, t = (offset - from.offset) / span;
    const values = {} as Record<Channel, number>;
    for (const channel of channels) {
      const incoming = start === 0 ? 0 : (to[channel] - before[channel]) / (to.offset - before.offset) * span;
      const outgoing = end === points.length - 1 ? 0 : (after[channel] - from[channel]) / (after.offset - from.offset) * span;
      values[channel] = (2 * t ** 3 - 3 * t ** 2 + 1) * from[channel] + (t ** 3 - 2 * t ** 2 + t) * incoming
        + (-2 * t ** 3 + 3 * t ** 2) * to[channel] + (t ** 3 - t ** 2) * outgoing;
    }
    return { offset, ...values };
  });
}
