import { successResponse, wrap, IResponse } from "./utils/shared";
import peggedAssets from "./peggedData/peggedData";
import dynamodb from "./utils/shared/dynamodb";
import getTVLOfRecordClosestToTimestamp from "./utils/shared/getRecordClosestToTimestamp";
import { secondsInDay } from "./utils/date";
import {
  dailyPeggedPrices,
  getLastRecord,
  hourlyPeggedBalances,
} from "./peggedAssets/utils/getLastRecord";
import { getClosestDayStartTimestamp } from "./utils/date";
import { normalizeChain } from "./utils/normalizeChain";
import { secondsInHour } from "./utils/date";

type tokenBalance = {
  [token: string]: number | undefined;
};

export async function craftChartsResponse(
  chain: string | undefined,
  peggedAsset: string | undefined
) {
  const sumDailyBalances = {} as {
    [timestamp: number]: {
      circulating: tokenBalance;
      unreleased: tokenBalance;
      mcap: number;
    };
  };
  // quick fix; need to update later
  if ((chain === "Gnosis") || (chain === "gnosis")) {
    chain = "xdai";
  }

  const normalizedChain =
    chain === undefined ? undefined : normalizeChain(chain);
  let lastDailyTimestamp = 0;
  /*
   * whenever "chain" and "peggedAsset", and peggedAsset has no entry in lastBalance for that chain,
   * historicalPeggedBalances is empty. Not sure exactly where that's happening.
   */
  const historicalPeggedBalances = await Promise.all(
    peggedAssets.map(async (pegged) => {
      if (peggedAsset && pegged.gecko_id !== peggedAsset) {
        return;
      }
      const lastBalance = await getLastRecord(hourlyPeggedBalances(pegged.id));
      if (normalizedChain !== undefined && !lastBalance?.[normalizedChain]) {
        return undefined;
      }
      if (
        normalizedChain !== undefined &&
        lastBalance?.[normalizedChain].circulating === undefined &&
        pegged.chain.toLowerCase() !== chain
      ) {
        return undefined;
      }
      const historicalBalance = await dynamodb.query({
        ExpressionAttributeValues: {
          ":pk": `dailyPeggedBalances#${pegged.id}`,
        },
        KeyConditionExpression: "PK = :pk",
      });
      if (
        historicalBalance.Items === undefined ||
        historicalBalance.Items.length < 1
      ) {
        return undefined;
      }
      const lastDailyItem =
        historicalBalance.Items[historicalBalance.Items.length - 1];
      if (
        lastBalance !== undefined &&
        lastBalance.SK > lastDailyItem.SK &&
        lastDailyItem.SK + secondsInHour * 25 > lastBalance.SK
      ) {
        lastBalance.SK = lastDailyItem.SK;
        historicalBalance.Items[historicalBalance.Items.length - 1] =
          lastBalance;
      }
      const lastTimestamp = getClosestDayStartTimestamp(
        historicalBalance.Items[historicalBalance.Items.length - 1].SK
      );
      lastDailyTimestamp = Math.max(lastDailyTimestamp, lastTimestamp);
      return {
        pegged,
        historicalBalance: historicalBalance.Items,
        lastTimestamp,
      };
    })
  );
  await Promise.all(
    historicalPeggedBalances.map(async (peggedBalance) => {
      if (peggedBalance === undefined) {
        return;
      }
      let { historicalBalance, pegged, lastTimestamp } = peggedBalance;
      const pegType = pegged.pegType;
      const peggedGeckoID = pegged.gecko_id;
      const lastBalance = historicalBalance[historicalBalance.length - 1];
      while (lastTimestamp < lastDailyTimestamp) {
        lastTimestamp = getClosestDayStartTimestamp(
          lastTimestamp + 24 * secondsInHour
        );
        historicalBalance.push({
          ...lastBalance,
          SK: lastTimestamp,
        });
      }
      await Promise.all(
        historicalBalance.map(async (item) => {
          const timestamp = getClosestDayStartTimestamp(item.SK);
          let itemBalance: any = {};

          const priceData = await getTVLOfRecordClosestToTimestamp(
            dailyPeggedPrices(),
            timestamp,
            secondsInDay / 2
          );
          if (chain === undefined) {
            itemBalance.circulating = item.totalCirculating.circulating;
            if (item.totalCirculating.unreleased) {
              itemBalance.unreleased = item.totalCirculating.unreleased;
            }
          } else {
            itemBalance.circulating =
              item[normalizeChain(chain)]?.circulating ?? 0;
            itemBalance.unreleased =
              item[normalizeChain(chain)]?.unreleased ?? 0;
            if (itemBalance.circulating === undefined) {
              if (chain === pegged.chain.toLowerCase()) {
                itemBalance.circulating = item.totalCirculating.circulating;
                if (item.totalCirculating.unreleased) {
                  itemBalance.unreleased = item.totalCirculating.unreleased;
                }
              } else {
                return;
              }
            }
          }

          // need stricter checks here
          if (itemBalance !== null) {
            sumDailyBalances[timestamp] = sumDailyBalances[timestamp] || {};
            sumDailyBalances[timestamp].circulating =
              sumDailyBalances[timestamp].circulating || {};
            sumDailyBalances[timestamp].circulating[pegType] =
              (sumDailyBalances[timestamp].circulating[pegType] ?? 0) +
              itemBalance.circulating[pegType];
            sumDailyBalances[timestamp] = sumDailyBalances[timestamp] || {};
            sumDailyBalances[timestamp].unreleased =
              sumDailyBalances[timestamp].unreleased || {};
            sumDailyBalances[timestamp].unreleased[pegType] =
              (sumDailyBalances[timestamp].unreleased[pegType] ?? 0) +
              itemBalance.unreleased[pegType];
            const price = priceData?.prices?.[peggedGeckoID];
            if (price) {
              sumDailyBalances[timestamp].mcap =
                (sumDailyBalances[timestamp].mcap ?? 0) +
                itemBalance.circulating[pegType] * price;
            } else {
              sumDailyBalances[timestamp].mcap =
                (sumDailyBalances[timestamp].mcap ?? 0) +
                itemBalance.circulating[pegType];
            }
          } else {
            console.log(
              "itemBalance is invalid",
              itemBalance,
              item,
              pegged,
              lastTimestamp,
              historicalBalance
            );
          }
        })
      );
    })
  );

  const response = Object.entries(sumDailyBalances).map(
    ([timestamp, balance]) => ({
      date: timestamp,
      totalCirculating: balance.circulating,
      unreleased: balance.unreleased,
      mcap: balance.mcap,
    })
  );

  return response;
}

const handler = async (
  event: AWSLambda.APIGatewayEvent
): Promise<IResponse> => {
  const chain = event.pathParameters?.chain?.toLowerCase();
  const peggedAsset = event.queryStringParameters?.peggedAsset?.toLowerCase();
  const response = await craftChartsResponse(chain, peggedAsset);
  return successResponse(response, 10 * 60); // 10 mins cache
};

export default wrap(handler);
