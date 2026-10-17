// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * S15 dependency audit (`npm run check:deps`).
 *
 * Runtime closure = workspace packages that are actually deployed to a target
 * host: `@ss/rtdb-core`, `@ss/rtdb-client`, `@ss/rtdb-server`, `@ss/rtdb-cli`.
 * `@ss/rtdb-admin` is build-time only (Vue3 + Vite): its Vite/Rollup/esbuild
 * toolchain lives in `devDependencies` and its output is static assets served
 * by rtdb-server, so it never reaches a production `node_modules`.
 * `packages/demo/client-python` is a Python package (stdlib only, no npm install); the demo clients
 * live under `packages/demo/*` (also npm workspaces) and must stay dependency-free as well.
 *
 * Assertions:
 *   1. the runtime closure declares zero third-party dependency (every
 *      dependency resolves to a workspace package);
 *   2. no native module (`*.node`) lives inside a runtime package directory;
 *   3. every native module under `node_modules` is reachable from the workspace
 *      `devDependencies` closure, i.e. belongs to the dev-only build toolchain
 *      (no unknown native artifact).
 *
 * Usage: node scripts/check-runtime-dependencies.ts [--json]
 * Exit code: 0 = compliant, 1 = violation.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- 常量 ---------- */

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIRECTORY = join(ROOT_DIRECTORY, 'packages');
const NODE_MODULES_DIRECTORY = join(ROOT_DIRECTORY, 'node_modules');

/** 运行时刻真正下发到目标主机的包（Python SDK 为 stdlib 纯解释器包，不参与 npm 闭包） */
const RUNTIME_PACKAGE_NAMES: readonly string[] = [
  '@ss/rtdb-core',
  '@ss/rtdb-client',
  '@ss/rtdb-server',
  '@ss/rtdb-cli',
];

/** node_modules 内不参与原生模块归属统计的条目 */
const SKIPPED_NODE_MODULES_ENTRIES = new Set(['.bin', '.vite-temp', '.package-lock.json']);

/** 视为原生模块的文件扩展名 */
const NATIVE_EXTENSIONS = new Set(['.node', '.exe']);

/* ---------- 类型 ---------- */

/** package.json 中与依赖解析相关的字段 */
interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 工作区包（`packages/*` 中存在 package.json 的目录） */
interface WorkspacePackage {
  name: string;
  directory: string;
  manifest: PackageManifest;
}

/** 原生模块产物及其归属包 */
interface NativeArtifact {
  relativePath: string;
  owner: string;
  /** 是否属于 dev-only 构建工具链闭包（true = 允许，false = 违规） */
  devOnlyToolchain: boolean;
}

/* ---------- 基础读取 ---------- */

/** 读取 JSON 文件（不存在或不可解析时返回 null，不抛错） */
function readJsonIfExists(filePath: string): PackageManifest | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * 列出工作区包（`packages/*` 与 `packages/demo/*`，按包名排序保证输出稳定）。
 * 与根 `package.json` 的 `workspaces` 保持一致：`demo` 目录本身没有 manifest 时继续下钻一层。
 */
function listWorkspacePackages(): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  const visit = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const child = join(directory, entry.name);
      const manifest = readJsonIfExists(join(child, 'package.json'));
      if (manifest?.name) {
        packages.push({ name: manifest.name, directory: child, manifest });
        continue;
      }
      if (depth < 2) visit(child, depth + 1);
    }
  };
  visit(PACKAGES_DIRECTORY, 1);
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

/** 已安装包清单路径（支持 `@scope/name` 两级） */
function installedManifestPath(packageName: string): string {
  return join(NODE_MODULES_DIRECTORY, ...packageName.split('/'), 'package.json');
}

/** 声明的依赖名（运行时分派口径：dependencies + optionalDependencies + peerDependencies） */
function declaredDependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

/* ---------- 依赖闭包 ---------- */

/** 依赖闭包计算结果 */
interface DependencyClosure {
  /** 闭包内命中的全部包名 */
  visited: Set<string>;
  /** 闭包内**非工作区**（第三方）包名 */
  thirdParty: Set<string>;
}

/**
 * 从给定根包出发做依赖闭包遍历
 *
 * 工作区包清单优先于 node_modules（同一包名不会既被当作工作区又被当作第三方）。
 * 未安装的包（如按平台裁剪掉的 optionalDependencies）返回 null 后跳过，不计入违规。
 */
function collectDependencyClosure(
  rootPackageNames: readonly string[],
  workspaceManifests: Map<string, PackageManifest>,
): DependencyClosure {
  const visited = new Set<string>();
  const thirdParty = new Set<string>();
  const queue = [...rootPackageNames];

  while (queue.length > 0) {
    const packageName = queue.pop() as string;
    if (visited.has(packageName)) continue;
    visited.add(packageName);

    const manifest = workspaceManifests.get(packageName) ?? readJsonIfExists(installedManifestPath(packageName));
    if (!manifest) continue;

    for (const dependencyName of declaredDependencyNames(manifest)) {
      if (workspaceManifests.has(dependencyName)) {
        queue.push(dependencyName);
        continue;
      }
      if (!visited.has(dependencyName)) thirdParty.add(dependencyName);
      queue.push(dependencyName);
    }
  }
  return { visited, thirdParty };
}

/* ---------- 原生模块扫描 ---------- */

/** 递归收集原生模块产物（相对 `node_modules` 的 POSIX 路径） */
function collectNativeArtifacts(directoryPath: string, relativePrefix: string, output: string[]): void {
  if (!existsSync(directoryPath)) return;
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (!relativePrefix && SKIPPED_NODE_MODULES_ENTRIES.has(entry.name)) continue;
    const entryRelativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectNativeArtifacts(entryPath, entryRelativePath, output);
      continue;
    }
    if (!entry.isFile()) continue; // 符号链接（`@ss/*` 指向 packages/*）不递归，避免重复统计
    if (NATIVE_EXTENSIONS.has(extname(entry.name).toLowerCase())) output.push(entryRelativePath);
  }
}

/** 由 `node_modules` 相对路径取归属包名（`@scope/name` 取两段） */
function artifactOwner(relativePath: string): string {
  const segments = relativePath.split('/');
  if (segments[0].startsWith('@') && segments.length > 1) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

/** 递归收集指定目录内的原生模块（用于运行时刻包目录自检；不含 node_modules 子树） */
function collectNativeArtifactsInDirectory(directoryPath: string, output: string[]): void {
  if (!existsSync(directoryPath)) return;
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectNativeArtifactsInDirectory(entryPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (NATIVE_EXTENSIONS.has(extname(entry.name).toLowerCase())) output.push(relative(ROOT_DIRECTORY, entryPath));
  }
}

/* ---------- 审计 ---------- */

/** 审计报告 */
interface AuditReport {
  workspacePackageNames: string[];
  runtimePackageNames: string[];
  runtimeThirdPartyDependencies: string[];
  runtimeNativeArtifacts: string[];
  nodeModulesNativeArtifacts: NativeArtifact[];
  nativeArtifactViolations: string[];
  violations: string[];
}

/** 执行审计 */
function auditRuntimeDependencies(): AuditReport {
  const workspacePackages = listWorkspacePackages();
  const workspaceManifests = new Map<string, PackageManifest>(
    workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage.manifest]),
  );

  const missingRuntimePackages = RUNTIME_PACKAGE_NAMES.filter((name) => !workspaceManifests.has(name));

  const runtimeClosure = collectDependencyClosure(RUNTIME_PACKAGE_NAMES, workspaceManifests);
  const runtimeThirdPartyDependencies = [...runtimeClosure.thirdParty].sort();

  const runtimeNativeArtifacts: string[] = [];
  for (const workspacePackage of workspacePackages) {
    if (!RUNTIME_PACKAGE_NAMES.includes(workspacePackage.name)) continue;
    collectNativeArtifactsInDirectory(workspacePackage.directory, runtimeNativeArtifacts);
  }

  // dev-only 闭包根 = 根 package.json devDependencies + 各工作区包 devDependencies
  const rootManifest = readJsonIfExists(join(ROOT_DIRECTORY, 'package.json'));
  const devDependencyRoots = [
    ...Object.keys(rootManifest?.devDependencies ?? {}),
    ...workspacePackages.flatMap((workspacePackage) => Object.keys(workspacePackage.manifest.devDependencies ?? {})),
  ];
  const devOnlyClosure = collectDependencyClosure([...new Set(devDependencyRoots)], workspaceManifests);

  const nodeModulesArtifacts: string[] = [];
  collectNativeArtifacts(NODE_MODULES_DIRECTORY, '', nodeModulesArtifacts);
  const nodeModulesNativeArtifacts: NativeArtifact[] = nodeModulesArtifacts
    .map((relativePath) => {
      const owner = artifactOwner(relativePath);
      return { relativePath, owner, devOnlyToolchain: devOnlyClosure.visited.has(owner) };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const nativeArtifactViolations = nodeModulesNativeArtifacts
    .filter((artifact) => !artifact.devOnlyToolchain)
    .map((artifact) => `${artifact.relativePath} (owner: ${artifact.owner})`);

  const violations: string[] = [];
  if (missingRuntimePackages.length > 0) {
    violations.push(`运行时刻包缺失: ${missingRuntimePackages.join(', ')}`);
  }
  if (runtimeThirdPartyDependencies.length > 0) {
    violations.push(`运行时刻闭包存在第三方依赖: ${runtimeThirdPartyDependencies.join(', ')}`);
  }
  if (runtimeNativeArtifacts.length > 0) {
    violations.push(`运行时刻包目录存在原生模块: ${runtimeNativeArtifacts.join(', ')}`);
  }
  if (nativeArtifactViolations.length > 0) {
    violations.push(`node_modules 存在非 dev-only 工具链的原生模块: ${nativeArtifactViolations.join(', ')}`);
  }

  return {
    workspacePackageNames: workspacePackages.map((workspacePackage) => workspacePackage.name),
    runtimePackageNames: [...RUNTIME_PACKAGE_NAMES],
    runtimeThirdPartyDependencies,
    runtimeNativeArtifacts,
    nodeModulesNativeArtifacts,
    nativeArtifactViolations,
    violations,
  };
}

/* ---------- 主流程 ---------- */

const report = auditRuntimeDependencies();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('================ ss-rtdb 依赖零原生模块校验（S15） ================');
  console.log(`工作区包 (${report.workspacePackageNames.length}): ${report.workspacePackageNames.join(', ')}`);
  console.log(`运行时刻闭包 (${report.runtimePackageNames.length}): ${report.runtimePackageNames.join(', ')}`);
  console.log(`运行时刻第三方依赖: ${report.runtimeThirdPartyDependencies.length} 项`);
  console.log(`运行时刻包目录原生模块: ${report.runtimeNativeArtifacts.length} 个`);
  console.log(`node_modules 原生模块: ${report.nodeModulesNativeArtifacts.length} 个`);
  for (const artifact of report.nodeModulesNativeArtifacts) {
    const classification = artifact.devOnlyToolchain ? 'dev-only 构建工具链' : '违规';
    console.log(`  · ${artifact.relativePath}  → ${artifact.owner} [${classification}]`);
  }
  if (report.violations.length > 0) {
    console.log('\n违规明细:');
    for (const violation of report.violations) console.log(`  - ${violation}`);
  }
  console.log(
    report.violations.length === 0
      ? '\n判定: PASS —— 运行时刻闭包零第三方依赖、零原生模块；残留原生模块全部属于 dev-only 构建工具链（生产部署不安装）。'
      : '\n判定: FAIL —— 存在依赖或原生模块违规，进程以非零码退出。',
  );
}

process.exitCode = report.violations.length > 0 ? 1 : 0;
