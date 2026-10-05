/** Centers in clockwise order, with the authenticated viewer at the bottom. */
const SEATS: Record<number, readonly (readonly [number, number])[]> = {
  4: [[50,88],[13,51],[50,13],[87,51]],
  5: [[50,88],[15,63],[29,17],[71,17],[85,63]],
  6: [[50,88],[13,64],[23,23],[50,11],[77,23],[87,64]],
  7: [[50,88],[13,70],[17,36],[37,13],[63,13],[83,36],[87,70]],
};
export function sceneSeatPosition(index: number, count: number) {
  const point = SEATS[count]?.[index];
  if (point) return { left: `${point[0]}%`, top: `${point[1]}%` };
  const angle = 2 * Math.PI * index / Math.max(1, count);
  return { left: `${50 - Math.sin(angle) * 36}%`, top: `${50 + Math.cos(angle) * 37}%` };
}
