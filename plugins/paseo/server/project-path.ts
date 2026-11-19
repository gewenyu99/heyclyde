import {realpathSync,statSync} from 'node:fs';
import {basename,isAbsolute} from 'node:path';
/** Explicit directory placement never searches for a Git ancestor or a child checkout. */
export function verifyDirectory(path:string):string {
  if(!isAbsolute(path) || path.includes('\0'))throw new Error('Enter an absolute local project directory path.');
  let root:string;
  try{root=realpathSync(path);if(!statSync(root).isDirectory())throw new Error();}
  catch{throw new Error('The selected project directory is unavailable.');}
  return root;
}
export function directorySlug(path:string):string {return basename(path).toLowerCase().replace(/[^a-z0-9_-]/g,'-').replace(/^-+|-+$/g,'') || 'local';}
