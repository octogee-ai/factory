import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = fileURLToPath(new URL('../../../docs/brand/product-tour/', import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(source, 'dist'));
const tour = JSON.parse(await readFile(path.join(source, 'tour.json'), 'utf8'));
await mkdir(output, { recursive: true });

const ffmpegPath = execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim();

function ffmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status}`);
}

const inputs = tour.scenes.flatMap((scene) => [
  '-loop', '1', '-framerate', String(tour.fps), '-t', String(scene.seconds),
  '-i', path.join(source, 'frames', `${scene.id}.jpg`),
]);
const filters = tour.scenes.map((scene, index) =>
  `[${index}:v]scale=${tour.width}:${tour.height},setsar=1,format=yuv420p,` +
  `fade=t=in:st=0:d=0.3,fade=t=out:st=${scene.seconds - 0.3}:d=0.3[v${index}]`,
);
filters.push(`${tour.scenes.map((_, index) => `[v${index}]`).join('')}concat=n=${tour.scenes.length}:v=1:a=0[video]`);
ffmpeg([
  ...inputs, '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[video]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(tour.fps),
  '-movflags', '+faststart', '-metadata', `title=${tour.title}`,
  '-metadata', 'comment=Captioned screenshot tour. All people and project content are fictional demo data. No audio.',
  path.join(output, 'octogee-product-tour.mp4'),
]);
ffmpeg(['-i', path.join(source, 'frames', 'intro.jpg'), '-vf', 'scale=1280:720', '-frames:v', '1', '-q:v', '2', path.join(output, 'thumbnail.jpg')]);

const timestamp = (seconds) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
const chapterTime = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
let elapsed = 0;
const chapters = [];
const captions = tour.scenes.map((scene, index) => {
  chapters.push(`${chapterTime(elapsed)} ${scene.chapter}`);
  const start = elapsed;
  elapsed += scene.seconds;
  return `${index + 1}\n${timestamp(start)} --> ${timestamp(elapsed)}\n${scene.caption}\n`;
});
await writeFile(path.join(output, 'captions.en.srt'), captions.join('\n'));
await writeFile(path.join(output, 'youtube.txt'), `${tour.title}

Meet Octogee: a personal AI partner platform for users and makers.
Follow a fictional neighborhood garden project from a conversation to a shared Canvas, project files, and a Board.

Explore the code: ${tour.repository}
Find a first contribution: ${tour.repository}/labels/good%20first%20issue
Architecture: ${tour.repository}/blob/main/docs/architecture/README.md

${chapters.join('\n')}

All names, messages, files, tasks, and activity are fictional demo data. This is a captioned screenshot tour recorded from current app components in an isolated local fixture. It does not show live AI generation, builds, or publishing. No narration or music.

Octogee's own code is MIT licensed; third-party components keep their own licenses. A full hosted installation currently requires operator setup; see the repository README.

Eight arms. One dream.
`);
console.log(`Rendered ${elapsed}s, ${tour.width}×${tour.height}, ${tour.fps}fps. Upload package: ${output}`);
