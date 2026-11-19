import { artwork } from "./brand.generated.ts";

// Add a white halo stroke around the outer backing path so static light and dark toolbars stay legible.
export const clydeIcon = {
  svg: artwork.light.mark.svg.replace(
    'fill="#ffffff" fill-rule="evenodd"/>',
    'fill="#ffffff" stroke="#ffffff" stroke-width="6" stroke-linejoin="round" fill-rule="evenodd"/>',
  ),
};
