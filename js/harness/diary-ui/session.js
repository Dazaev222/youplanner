import { unwrap } from './dom.js';
export async function subscribeDiary(composition, onChange) {
  return unwrap(await composition.service.subscribe({ onChange }));
}
