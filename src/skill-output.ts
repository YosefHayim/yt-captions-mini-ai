import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect, Either, Schema } from 'effect';
import { SkillPackage, SkillPackageFile } from './types.js';
import { skillFileCloseMarker, skillFileEndMarker, skillFileOpenMarker } from './skill-prompt.js';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  FILE_ENCODING,
  NEWLINE,
  RELATIVE_PATH_SEPARATOR,
} = CONSTANTS.shared;
const {
  SKILL_MARKDOWN_NAME,
  DEFAULT_SKILL_SLUG,
  FRONTMATTER_FENCE,
  INVALID_PATH_PATTERN,
  SKILL_NAME_PATTERN,
  NAME_LINE_PATTERN,
  DESCRIPTION_LINE_PATTERN,
} = CONSTANTS.skillOutput;

const skillFrontmatterSchema = Schema.Struct({
  // Skill slug used as directory/command name.
  name: Schema.optional(Schema.String),
  // Trigger-oriented description for auto-invocation.
  description: Schema.optional(Schema.String),
});

const decodeSkillFrontmatter = Schema.decodeUnknown(skillFrontmatterSchema);

const normalizeNewlines = (fileBody: string): string => fileBody.replace(/\r\n/g, NEWLINE);

const isSafeRelativePath = (relativePath: string): boolean => {
  // Reject absolute paths, parent escapes, and empty segments.
  if (!relativePath.length || INVALID_PATH_PATTERN.test(relativePath)) {
    return false;
  }
  return !relativePath.split(RELATIVE_PATH_SEPARATOR).some((pathSegment) => pathSegment.length === 0);
};

const slugifySkillName = (skillNameCandidate: string): string => {
  // Convert free-form skill titles into a portable skill slug.
  const loweredSkillName = skillNameCandidate.trim().toLowerCase();
  const hyphenatedSkillName = loweredSkillName
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, EMPTY_VALUE)
    .slice(0, 64);
  if (SKILL_NAME_PATTERN.test(hyphenatedSkillName)) {
    return hyphenatedSkillName;
  }
  return DEFAULT_SKILL_SLUG;
};

const extractFrontmatterName = (fileBody: string): string | null => {
  // Prefer YAML name: field when the body starts with frontmatter.
  const normalizedBody = normalizeNewlines(fileBody).trim();
  if (!normalizedBody.startsWith(FRONTMATTER_FENCE)) {
    return null;
  }
  const closingFenceOffset = normalizedBody.indexOf(NEWLINE + FRONTMATTER_FENCE, FRONTMATTER_FENCE.length);
  if (closingFenceOffset < 0) {
    return null;
  }
  const frontmatterText = normalizedBody.slice(FRONTMATTER_FENCE.length, closingFenceOffset).trim();
  const nameMatch = NAME_LINE_PATTERN.exec(frontmatterText);
  if (!nameMatch?.[1]) {
    return null;
  }
  return slugifySkillName(nameMatch[1]);
};

const ensureFrontmatter = (fileBody: string, skillName: string): string => {
  // 1) Keep existing valid frontmatter when present.
  const normalizedBody = normalizeNewlines(fileBody).trim();
  if (normalizedBody.startsWith(FRONTMATTER_FENCE)) {
    return `${normalizedBody}${NEWLINE}`;
  }

  // 2) Otherwise wrap the body in portable name/description frontmatter.
  const descriptionGuess =
    DESCRIPTION_LINE_PATTERN.exec(normalizedBody)?.[1]?.trim()
    ?? `Generated skill ${skillName}. Use when the transcript topic matches this skill.`;
  return `${FRONTMATTER_FENCE}${NEWLINE}name: ${skillName}${NEWLINE}description: ${descriptionGuess}${NEWLINE}${FRONTMATTER_FENCE}${NEWLINE}${NEWLINE}${normalizedBody}${NEWLINE}`;
};

const parseMarkedSkillFiles = (skillBody: string): SkillPackageFile[] => {
  // Parse ===FILE: path=== ... ===END=== envelopes emitted by the system prompt.
  const packageFiles: SkillPackageFile[] = [];
  const normalizedBody = normalizeNewlines(skillBody);
  let scanOffset = 0;

  while (scanOffset < normalizedBody.length) {
    const openMarkerOffset = normalizedBody.indexOf(skillFileOpenMarker, scanOffset);
    if (openMarkerOffset < 0) {
      break;
    }
    const pathStartOffset = openMarkerOffset + skillFileOpenMarker.length;
    const pathCloseOffset = normalizedBody.indexOf(skillFileCloseMarker, pathStartOffset);
    if (pathCloseOffset < 0) {
      break;
    }
    const relativePath = normalizedBody.slice(pathStartOffset, pathCloseOffset).trim();
    const contentStartOffset = pathCloseOffset + skillFileCloseMarker.length;
    const endMarkerOffset = normalizedBody.indexOf(skillFileEndMarker, contentStartOffset);
    if (endMarkerOffset < 0) {
      break;
    }
    const fileBody = normalizedBody.slice(contentStartOffset, endMarkerOffset).replace(/^\n+/, EMPTY_VALUE).trimEnd();
    if (isSafeRelativePath(relativePath) && fileBody.length > 0) {
      packageFiles.push({
        relativePath,
        fileBody: `${fileBody}${NEWLINE}`,
      });
    }
    scanOffset = endMarkerOffset + skillFileEndMarker.length;
  }

  return packageFiles;
};

const parseSingleSkillFallback = (skillBody: string): SkillPackageFile[] => {
  // Treat the whole response as one SKILL.md when no file markers are present.
  const skillName = extractFrontmatterName(skillBody) ?? DEFAULT_SKILL_SLUG;
  const skillBodyWithFrontmatter = ensureFrontmatter(skillBody, skillName);
  return [
    {
      relativePath: `${skillName}${RELATIVE_PATH_SEPARATOR}${SKILL_MARKDOWN_NAME}`,
      fileBody: skillBodyWithFrontmatter,
    },
  ];
};

export const parseSkillPackage = (skillBody: string): SkillPackage => {
  // 1) Prefer multi-file markers from the skill system prompt.
  // 2) Fall back to a single generated-skill/SKILL.md package.
  const markedFiles = parseMarkedSkillFiles(skillBody);
  const packageFiles = markedFiles.length > 0 ? markedFiles : parseSingleSkillFallback(skillBody);

  // 3) Collect top-level skill directory names for logging.
  const skillDirectoryNames = [
    ...new Set(
      packageFiles
        .map((packageFile) => packageFile.relativePath.split(RELATIVE_PATH_SEPARATOR)[0] ?? EMPTY_VALUE)
        .filter((directoryName) => directoryName.length > 0),
    ),
  ];

  // 4) Ensure every SKILL.md has frontmatter (schema-validated when possible).
  const normalizedFiles = packageFiles.map((packageFile) => {
    const pathBaseName = path.posix.basename(packageFile.relativePath);
    if (pathBaseName.toLowerCase() !== SKILL_MARKDOWN_NAME.toLowerCase()) {
      return packageFile;
    }
    const skillName =
      extractFrontmatterName(packageFile.fileBody)
      ?? slugifySkillName(packageFile.relativePath.split(RELATIVE_PATH_SEPARATOR)[0] ?? DEFAULT_SKILL_SLUG);
    const fileBody = ensureFrontmatter(packageFile.fileBody, skillName);
    const frontmatterEither = Effect.runSync(
      Effect.either(
        decodeSkillFrontmatter({
          name: extractFrontmatterName(fileBody) ?? skillName,
          description: DESCRIPTION_LINE_PATTERN.exec(fileBody)?.[1],
        }),
      ),
    );
    if (Either.isLeft(frontmatterEither)) {
      return {
        relativePath: packageFile.relativePath,
        fileBody,
      };
    }
    return {
      relativePath: packageFile.relativePath,
      fileBody,
    };
  });

  return {
    packageFiles: normalizedFiles,
    skillDirectoryNames,
  };
};

export const persistSkillPackage = async (
  packageRootDirectory: string,
  skillPackage: SkillPackage,
): Promise<string[]> => {
  // 1) Ensure the package root exists.
  await mkdir(packageRootDirectory, { recursive: true });
  const writtenPaths: string[] = [];

  // 2) Write each relative file under the package root.
  for (const packageFile of skillPackage.packageFiles) {
    if (!isSafeRelativePath(packageFile.relativePath)) {
      continue;
    }
    const absoluteFilePath = path.join(packageRootDirectory, packageFile.relativePath);
    await mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await writeFile(absoluteFilePath, packageFile.fileBody, FILE_ENCODING);
    writtenPaths.push(absoluteFilePath);
  }

  // 3) Return written paths for logging.
  return writtenPaths;
};
