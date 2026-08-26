import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BotProfile, ThinkingLevel } from "./types.ts";

type ModelContext = Pick<ExtensionContext, "modelRegistry" | "scopedModels">;

export function botModelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function selectableBotModels(context: ModelContext): Model<Api>[] {
  const source =
    context.scopedModels.length > 0
      ? context.scopedModels.map((entry) => entry.model)
      : context.modelRegistry.getAvailable();
  return [
    ...new Map(source.map((model) => [botModelKey(model), model])).values(),
  ].sort((left, right) => botModelKey(left).localeCompare(botModelKey(right)));
}

export function supportedBotThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export function defaultBotThinkingLevel(
  model: Model<Api>,
  requested: ThinkingLevel | undefined,
): ThinkingLevel {
  return clampThinkingLevel(model, requested ?? "medium") as ThinkingLevel;
}

export function unavailableBotModelIds(
  context: ModelContext,
  bots: readonly BotProfile[],
): string[] {
  const available = new Set(selectableBotModels(context).map(botModelKey));
  return bots.flatMap((bot) => {
    const preferred = bot.modelPolicy.preferred;
    return preferred && !available.has(preferred) ? [preferred] : [];
  });
}
