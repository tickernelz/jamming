import { readFileSync } from 'node:fs';

export const APP_FILES = ['app.js', 'app-room.js', 'app-solo.js', 'app-dock.js', 'app-util.js'];

export const appSource = () => APP_FILES
    .map((name) => readFileSync(new URL(`../../public/js/${name}`, import.meta.url), 'utf8'))
    .join('\n');
