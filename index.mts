import { spawnSync } from 'child_process';
import * as https from 'https';
import { createReadStream, createWriteStream } from 'fs';
import { readFile, stat, unlink, writeFile } from 'fs/promises';
import { createWorker } from 'tesseract.js';
import puppeteer from 'puppeteer-core';
import { Telegraf } from 'telegraf';
import chalk from 'chalk';

const kSnapChromePath = '/snap/bin/chromium';
const kMacOSChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const kFacebookPage = 'https://www.facebook.com/SOAPA.Oax';
const kFacebookScrollLimit = 10;
const kTempImage = './fb-post-image.jpeg';
const kHistoryFile = './history.json';
const kDateRegex = /[0-9]{1,2}\sde\s[A-Za-z]+\sde\s[0-9]{4}/;
const kHeadingRegex = /^[A-Z\-\s]+$/;
const kBulletRegex = /^[«\-“]\s?/;
const kConfidenceThreshold = 30;
const kBaselineVariance = 40;

interface History {
  history: string[];
}

interface TesseractLine {
  text: string;
  confidence: number;
  baseline: TesseractBaseline;
}

interface TesseractBaseline {
  x0: number;
}

interface ParsedOCR {
  text: string;
  xBaseline: number;
}

type DownloadResponseType = { pipe: Function };

class FacebookError extends Error {}
class TelegramError extends Error {}
class OCRError extends Error {}
class DownloadError extends Error {}
class DuplicateError extends Error {}
class HistoryError extends Error {}

async function parseText(image: string) {
  const worker = await createWorker('spa');
  const result = await worker.recognize(image);

  let parsed: ParsedOCR[] = result.data.paragraphs
    .reduce(
      (acc, paragraph): TesseractLine[] => [...acc, ...paragraph.lines],
      [] as TesseractLine[],
    )
    .filter(line => line.confidence > kConfidenceThreshold)
    .map(
      line =>
        ({
          text: line.text.replace(/^[\s\n]*|[\s\n]+$/g, ''),
          xBaseline: line.baseline.x0,
        }) as ParsedOCR,
    )
    .filter((line: ParsedOCR) => !line.text.match(/^\s*$/));

  // trim everything up to date
  while (parsed.length && !kDateRegex.test(parsed[0].text)) {
    parsed.splice(0, 1);
  }

  // trim result text
  let i = 0;
  let date, turn;
  let firstHeadingXBaseline, firstBulletXBaseline;
  let isDate, isHeading, isBullet;
  while (parsed.length > 0 && i < parsed.length) {
    isDate = kDateRegex.test(parsed[i].text);
    isHeading = kHeadingRegex.test(parsed[i].text);

    if (!isDate && !isHeading) {
      // bullet
      if (firstBulletXBaseline === undefined) {
        firstBulletXBaseline = parsed[i].xBaseline;
      }

      // check if it fits first baseline otherwise ditch
      if (Math.abs(parsed[i].xBaseline - firstBulletXBaseline) < kBaselineVariance) {
        parsed[i].text = `- ${parsed[i].text.replace(kBulletRegex, '')}`;
      } else {
        parsed.splice(i--, 1);
      }
    } else if (isHeading) {
      // heading
      if (!parsed[i].text.includes('TURNO')) {
        if (firstHeadingXBaseline == undefined) {
          firstHeadingXBaseline = parsed[i].xBaseline;
        }

        if (Math.abs(parsed[i].xBaseline - firstHeadingXBaseline) < kBaselineVariance) {
          parsed.splice(i++, 0, { text: '', xBaseline: parsed[i].xBaseline });
        } else {
          parsed.splice(i--, 1);
        }
      } else {
        turn = parsed[i].text
          .replace(/^TURNO\s?/, '')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .toLowerCase();
      }
    } else if (isDate) {
      date = parsed[i].text.replace(/[^a-zA-Z0-9]+/g, '-');
    }

    i = i + 1;
  }

  const text = parsed.map(line => line.text).join('\n');

  await worker.terminate();

  return { id: `${date}-${turn || 'unknown'}`, text: text };
}

async function getLatestPost(): Promise<string> {
  const path = process.platform == 'darwin' ? kMacOSChromePath : kSnapChromePath;
  const browser = await puppeteer.launch({ executablePath: path });
  const page = await browser.newPage();

  try {
    let hasPost = false;
    let scrolls = 0;

    await page.setViewport({ width: 1024, height: 2000 });

    if (process.env.UA_AGENT) {
      await page.setUserAgent(process.env.UA_AGENT);
    }

    await page.goto(kFacebookPage);

    await page.waitForSelector('[role="article"]');

    await page.click('[role="dialog"] [role="button"]');

    await page.waitForNetworkIdle();

    // scroll down to update post
    while (!hasPost && scrolls++ < kFacebookScrollLimit) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForNetworkIdle();

      hasPost = await page.evaluate(() => {
        return document.body.textContent?.includes('#HoyLlegaElAgua') ?? false;
      });
    }

    if (!hasPost) throw new FacebookError();

    const imageUrl = await page.$$eval('[role="article"]', blocks => {
      const post = blocks.find(block => block.textContent?.includes('#HoyLlegaElAgua'));
      const image = post ? post.querySelector('a img') : null;

      if (!image) throw new FacebookError();

      return image.getAttribute('src') as string;
    });

    await browser.close();

    return imageUrl;
  } catch (err) {
    await page.screenshot({ path: 'screenshot.png' });

    await browser.close();

    throw err;
  }
}

async function downloadImage(imageUrl: string): Promise<string> {
  const file = createWriteStream(kTempImage);

  return new Promise((resolve, reject) => {
    https
      .get(imageUrl, (response: DownloadResponseType) => {
        response.pipe(file);

        file.on('finish', () => {
          file.close();

          resolve(kTempImage);
        });
      })
      .on('error', async (err: Error) => {
        await unlink(kTempImage);

        reject(new DownloadError());
      });
  });
}

async function postToTelegram(text: string) {
  try {
    const bot = new Telegraf(process.env.TELEGRAM_TOKEN as string);

    bot.launch();

    await bot.telegram.sendMessage('@agua_oaxaca', text);

    bot.stop();
  } catch (err) {
    throw new TelegramError();
  }
}

async function verifyExisting(id: string) {
  try {
    await stat(kHistoryFile);
  } catch (err) {
    await writeFile(kHistoryFile, '{"history":[]}');
  }

  const json = await readHistory();

  if (json.history.includes(id)) {
    throw new DuplicateError();
  }
}

async function recordNotification(id: string) {
  try {
    const json = await readHistory();

    json.history.splice(0, 0, id);

    json.history = json.history.slice(0, 10);

    await writeFile(kHistoryFile, JSON.stringify(json));
  } catch (err) {
    throw new HistoryError();
  }
}

async function readHistory(): Promise<History> {
  try {
    let content = await readFile(kHistoryFile, 'utf8');

    return JSON.parse(content) as History;
  } catch (err) {
    throw err;
  }
}

(async () => {
  try {
    console.log(chalk.blue('Checking water...'));

    console.log(chalk.yellow('\nRetrieving Facebook Post'));
    const imageUrl = await getLatestPost();
    console.log(chalk.green('• Success'));

    console.log(chalk.yellow('\nDownloading Post Image...'));
    const image = await downloadImage(imageUrl);
    console.log(chalk.green('• Success'));

    console.log(chalk.yellow('\nProcessing Image...'));
    const processed = await parseText(image);
    console.log(chalk.green('• Success'));

    console.log(chalk.yellow('\nVerifying status...'));
    await verifyExisting(processed.id);
    console.log(chalk.green('• Success'));

    console.log(chalk.yellow('\nPosting to Telegram...'));
    await postToTelegram(processed.text);
    console.log(chalk.green('• Success'));

    console.log(chalk.yellow('\nRecording notification...'));
    await recordNotification(processed.id);
    console.log(chalk.green('• Success'));
  } catch (err) {
    if (err instanceof FacebookError) {
      console.log(chalk.red('! Failed to retrieve Facebook post'));
    } else if (err instanceof DownloadError) {
      console.log(chalk.red('! Failed to download image'));
    } else if (err instanceof TelegramError) {
      console.log(chalk.red('! Failed to post to Telegram'));
    } else if (err instanceof HistoryError) {
      console.log(chalk.red('! Failed to record history'));
    } else if (err instanceof DuplicateError) {
      console.log(chalk.magenta('! Notification already posted'));
    } else {
      console.log(chalk.red(`! Generic Error: ${err}`));
    }
  }

  console.log(chalk.blue('\nTerminating.'));
})();
