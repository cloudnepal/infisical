/* eslint-disable no-await-in-loop */
import { Knex } from "knex";

import { TDbClient } from "@app/db";
import {
  SecretVersionsSchema,
  TableName,
  TSecretFolderVersions,
  TSecretSnapshotFolders,
  TSecretSnapshots,
  TSecretVersions
} from "@app/db/schemas";
import { DatabaseError } from "@app/lib/errors";
import { ormify, selectAllTableCols, sqlNestRelationships } from "@app/lib/knex";
import { logger } from "@app/lib/logger";

export type TSnapshotDALFactory = ReturnType<typeof snapshotDALFactory>;

export const snapshotDALFactory = (db: TDbClient) => {
  const secretSnapshotOrm = ormify(db, TableName.Snapshot);

  const findById = async (id: string, tx?: Knex) => {
    try {
      const data = await (tx || db.replicaNode())(TableName.Snapshot)
        .where(`${TableName.Snapshot}.id`, id)
        .join(TableName.Environment, `${TableName.Snapshot}.envId`, `${TableName.Environment}.id`)
        .select(selectAllTableCols(TableName.Snapshot))
        .select(
          db.ref("id").withSchema(TableName.Environment).as("envId"),
          db.ref("projectId").withSchema(TableName.Environment),
          db.ref("name").withSchema(TableName.Environment).as("envName"),
          db.ref("slug").withSchema(TableName.Environment).as("envSlug")
        )
        .first();
      if (data) {
        const { envId, envName, envSlug } = data;
        return { ...data, envId, enviroment: { id: envId, name: envName, slug: envSlug } };
      }
    } catch (error) {
      throw new DatabaseError({ error, name: "FindById" });
    }
  };

  const countOfSnapshotsByFolderId = async (folderId: string, tx?: Knex) => {
    try {
      const doc = await (tx || db.replicaNode())(TableName.Snapshot)
        .where({ folderId })
        .groupBy(["folderId"])
        .count("folderId")
        .first();
      return parseInt((doc?.count as string) || "0", 10);
    } catch (error) {
      throw new DatabaseError({ error, name: "CountOfProjectSnapshot" });
    }
  };

  const findSecretSnapshotDataById = async (snapshotId: string, tx?: Knex) => {
    try {
      const data = await (tx || db.replicaNode())(TableName.Snapshot)
        .where(`${TableName.Snapshot}.id`, snapshotId)
        .join(TableName.Environment, `${TableName.Snapshot}.envId`, `${TableName.Environment}.id`)
        .leftJoin(TableName.SnapshotSecret, `${TableName.Snapshot}.id`, `${TableName.SnapshotSecret}.snapshotId`)
        .leftJoin(
          TableName.SecretVersion,
          `${TableName.SnapshotSecret}.secretVersionId`,
          `${TableName.SecretVersion}.id`
        )
        .leftJoin(
          TableName.SecretVersionTag,
          `${TableName.SecretVersionTag}.${TableName.SecretVersion}Id`,
          `${TableName.SecretVersion}.id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretVersionTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )
        .leftJoin(TableName.SnapshotFolder, `${TableName.SnapshotFolder}.snapshotId`, `${TableName.Snapshot}.id`)
        .leftJoin<TSecretFolderVersions>(
          TableName.SecretFolderVersion,
          `${TableName.SnapshotFolder}.folderVersionId`,
          `${TableName.SecretFolderVersion}.id`
        )
        .select(selectAllTableCols(TableName.SecretVersion))
        .select(
          db.ref("id").withSchema(TableName.Snapshot).as("snapshotId"),
          db.ref("createdAt").withSchema(TableName.Snapshot).as("snapshotCreatedAt"),
          db.ref("updatedAt").withSchema(TableName.Snapshot).as("snapshotUpdatedAt"),
          db.ref("id").withSchema(TableName.Environment).as("envId"),
          db.ref("name").withSchema(TableName.Environment).as("envName"),
          db.ref("slug").withSchema(TableName.Environment).as("envSlug"),
          db.ref("projectId").withSchema(TableName.Environment),
          db.ref("name").withSchema(TableName.SecretFolderVersion).as("folderVerName"),
          db.ref("folderId").withSchema(TableName.SecretFolderVersion).as("folderVerId"),
          db.ref("id").withSchema(TableName.SecretTag).as("tagId"),
          db.ref("id").withSchema(TableName.SecretVersionTag).as("tagVersionId"),
          db.ref("color").withSchema(TableName.SecretTag).as("tagColor"),
          db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"),
          db.ref("name").withSchema(TableName.SecretTag).as("tagName")
        );
      return sqlNestRelationships({
        data,
        key: "snapshotId",
        parentMapper: ({
          snapshotId: id,
          folderId,
          projectId,
          envId,
          envSlug,
          envName,
          snapshotCreatedAt: createdAt,
          snapshotUpdatedAt: updatedAt
        }) => ({
          id,
          folderId,
          projectId,
          createdAt,
          updatedAt,
          environment: { id: envId, slug: envSlug, name: envName }
        }),
        childrenMapper: [
          {
            key: "id",
            label: "secretVersions" as const,
            mapper: (el) => SecretVersionsSchema.parse(el),
            childrenMapper: [
              {
                key: "tagVersionId",
                label: "tags" as const,
                mapper: ({ tagId: id, tagName: name, tagSlug: slug, tagColor: color, tagVersionId: vId }) => ({
                  id,
                  name,
                  slug,
                  color,
                  vId
                })
              }
            ]
          },
          {
            key: "folderVerId",
            label: "folderVersion" as const,
            mapper: ({ folderVerId: id, folderVerName: name }) => ({ id, name })
          }
        ]
      })?.[0];
    } catch (error) {
      throw new DatabaseError({ error, name: "FindSecretSnapshotDataById" });
    }
  };

  // this is used for rollback
  // from a starting snapshot it will collect all the secrets and folder of that
  // then it will start go through recursively the below folders latest snapshots then their child folder snapshot until leaf node
  // the recursive part find all snapshot id
  // then joins with respective secrets and folder
  const findRecursivelySnapshots = async (snapshotId: string, tx?: Knex) => {
    try {
      const data = await (tx || db)
        .withRecursive("parent", (qb) => {
          void qb
            .from(TableName.Snapshot)
            .leftJoin<TSecretSnapshotFolders>(
              TableName.SnapshotFolder,
              `${TableName.SnapshotFolder}.snapshotId`,
              `${TableName.Snapshot}.id`
            )
            .leftJoin<TSecretFolderVersions>(
              TableName.SecretFolderVersion,
              `${TableName.SnapshotFolder}.folderVersionId`,
              `${TableName.SecretFolderVersion}.id`
            )
            .select(selectAllTableCols(TableName.Snapshot))
            .select({ depth: 1 })
            .select(
              db.ref("name").withSchema(TableName.SecretFolderVersion).as("folderVerName"),
              db.ref("folderId").withSchema(TableName.SecretFolderVersion).as("folderVerId")
            )
            .where(`${TableName.Snapshot}.id`, snapshotId)
            .union(
              (cb) =>
                void cb
                  .select(selectAllTableCols(TableName.Snapshot))
                  .select({ depth: db.raw("parent.depth + 1") })
                  .select(
                    db.ref("name").withSchema(TableName.SecretFolderVersion).as("folderVerName"),
                    db.ref("folderId").withSchema(TableName.SecretFolderVersion).as("folderVerId")
                  )
                  .from(TableName.Snapshot)
                  .join<TSecretSnapshots, TSecretSnapshots & { secretId: string; max: number }>(
                    db(TableName.Snapshot).groupBy("folderId").max("createdAt").select("folderId").as("latestVersion"),
                    `${TableName.Snapshot}.createdAt`,
                    "latestVersion.max"
                  )
                  .leftJoin<TSecretSnapshotFolders>(
                    TableName.SnapshotFolder,
                    `${TableName.SnapshotFolder}.snapshotId`,
                    `${TableName.Snapshot}.id`
                  )
                  .leftJoin<TSecretFolderVersions>(
                    TableName.SecretFolderVersion,
                    `${TableName.SnapshotFolder}.folderVersionId`,
                    `${TableName.SecretFolderVersion}.id`
                  )
                  .join("parent", "parent.folderVerId", `${TableName.Snapshot}.folderId`)
            );
        })
        .orderBy("depth", "asc")
        .from<TSecretSnapshots & { folderVerId: string; folderVerName: string }>("parent")
        .leftJoin<TSecretSnapshots>(TableName.SnapshotSecret, `parent.id`, `${TableName.SnapshotSecret}.snapshotId`)
        .leftJoin<TSecretVersions>(
          TableName.SecretVersion,
          `${TableName.SnapshotSecret}.secretVersionId`,
          `${TableName.SecretVersion}.id`
        )
        .leftJoin(
          TableName.SecretVersionTag,
          `${TableName.SecretVersionTag}.${TableName.SecretVersion}Id`,
          `${TableName.SecretVersion}.id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretVersionTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )
        .leftJoin<{ latestSecretVersion: number }>(
          (tx || db)(TableName.SecretVersion)
            .groupBy("secretId")
            .select("secretId")
            .max("version")
            .as("secGroupByMaxVersion"),
          `${TableName.SecretVersion}.secretId`,
          "secGroupByMaxVersion.secretId"
        )
        .leftJoin<{ latestFolderVersion: number }>(
          (tx || db)(TableName.SecretFolderVersion)
            .groupBy("folderId")
            .select("folderId")
            .max("version")
            .as("folderGroupByMaxVersion"),
          `parent.folderId`,
          "folderGroupByMaxVersion.folderId"
        )
        .select(selectAllTableCols(TableName.SecretVersion))
        .select(
          db.ref("id").withSchema("parent").as("snapshotId"),
          db.ref("folderId").withSchema("parent").as("snapshotFolderId"),
          db.ref("parentFolderId").withSchema("parent").as("snapshotParentFolderId"),
          db.ref("folderVerName").withSchema("parent"),
          db.ref("folderVerId").withSchema("parent"),
          db.ref("max").withSchema("secGroupByMaxVersion").as("latestSecretVersion"),
          db.ref("max").withSchema("folderGroupByMaxVersion").as("latestFolderVersion"),
          db.ref("id").withSchema(TableName.SecretTag).as("tagId"),
          db.ref("id").withSchema(TableName.SecretVersionTag).as("tagVersionId"),
          db.ref("color").withSchema(TableName.SecretTag).as("tagColor"),
          db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"),
          db.ref("name").withSchema(TableName.SecretTag).as("tagName")
        );

      const formated = sqlNestRelationships({
        data,
        key: "snapshotId",
        parentMapper: ({ snapshotId: id, snapshotFolderId: folderId, snapshotParentFolderId: parentFolderId }) => ({
          id,
          folderId,
          parentFolderId
        }),
        childrenMapper: [
          {
            key: "id",
            label: "secretVersions" as const,
            mapper: (el) => ({
              ...SecretVersionsSchema.parse(el),
              latestSecretVersion: el.latestSecretVersion as number
            }),
            childrenMapper: [
              {
                key: "tagVersionId",
                label: "tags" as const,
                mapper: ({ tagId: id, tagName: name, tagSlug: slug, tagColor: color, tagVersionId: vId }) => ({
                  id,
                  name,
                  slug,
                  color,
                  vId
                })
              }
            ]
          },
          {
            key: "folderVerId",
            label: "folderVersion" as const,
            mapper: ({ folderVerId: id, folderVerName: name, latestFolderVersion }) => ({
              id,
              name,
              latestFolderVersion: latestFolderVersion as number
            })
          }
        ]
      });
      return formated;
    } catch (error) {
      throw new DatabaseError({ error, name: "FindRecursivelySnapshots" });
    }
  };

  // instead of copying all child folders
  // we will take the latest snapshot of those folders
  // when we need to rollback we will pull from these snapshots
  const findLatestSnapshotByFolderId = async (folderId: string, tx?: Knex) => {
    try {
      const docs = await (tx || db.replicaNode())(TableName.Snapshot)
        .where(`${TableName.Snapshot}.folderId`, folderId)
        .join<TSecretSnapshots>(
          (tx || db)(TableName.Snapshot).groupBy("folderId").max("createdAt").select("folderId").as("latestVersion"),
          (bd) => {
            bd.on(`${TableName.Snapshot}.folderId`, "latestVersion.folderId").andOn(
              `${TableName.Snapshot}.createdAt`,
              "latestVersion.max"
            );
          }
        )
        .first();
      return docs;
    } catch (error) {
      throw new DatabaseError({ error, name: "FindLatestVersionByFolderId" });
    }
  };

  /**
   * Prunes excess snapshots from the database to ensure only a specified number of recent snapshots are retained for each folder.
   *
   * This function operates in three main steps:
   * 1. Pruning snapshots from current folders.
   * 2. Pruning snapshots from non-current folders (versioned ones).
   * 3. Removing orphaned snapshots that do not belong to any existing folder or folder version.
   *
   * The function processes snapshots in batches, determined by the `PRUNE_FOLDER_BATCH_SIZE` constant,
   * to manage the large datasets without overwhelming the DB.
   *
   * Steps:
   * - Fetch a batch of folder IDs.
   * - For each batch, use a Common Table Expression (CTE) to rank snapshots within each folder by their creation date.
   * - Identify and delete snapshots that exceed the project's point-in-time version limit (`pitVersionLimit`).
   * - Repeat the process for versioned folders.
   * - Finally, delete orphaned snapshots that do not have an associated folder.
   */
  const pruneExcessSnapshots = async () => {
    const PRUNE_FOLDER_BATCH_SIZE = 10000;

    try {
      let uuidOffset = "00000000-0000-0000-0000-000000000000";
      // cleanup snapshots from current folders
      // eslint-disable-next-line no-constant-condition, no-unreachable-loop
      while (true) {
        const folderBatch = await db(TableName.SecretFolder)
          .where("id", ">", uuidOffset)
          .where("isReserved", false)
          .orderBy("id", "asc")
          .limit(PRUNE_FOLDER_BATCH_SIZE)
          .select("id");

        const batchEntries = folderBatch.map((folder) => folder.id);

        if (folderBatch.length) {
          try {
            logger.info(`Pruning snapshots in [range=${batchEntries[0]}:${batchEntries[batchEntries.length - 1]}]`);
            await db(TableName.Snapshot)
              .with("snapshot_cte", (qb) => {
                void qb
                  .from(TableName.Snapshot)
                  .whereIn(`${TableName.Snapshot}.folderId`, batchEntries)
                  .select(
                    "folderId",
                    `${TableName.Snapshot}.id as id`,
                    db.raw(
                      `ROW_NUMBER() OVER (PARTITION BY ${TableName.Snapshot}."folderId" ORDER BY ${TableName.Snapshot}."createdAt" DESC) AS row_num`
                    )
                  );
              })
              .join(TableName.SecretFolder, `${TableName.SecretFolder}.id`, `${TableName.Snapshot}.folderId`)
              .join(TableName.Environment, `${TableName.Environment}.id`, `${TableName.SecretFolder}.envId`)
              .join(TableName.Project, `${TableName.Project}.id`, `${TableName.Environment}.projectId`)
              .join("snapshot_cte", "snapshot_cte.id", `${TableName.Snapshot}.id`)
              .whereRaw(`snapshot_cte.row_num > ${TableName.Project}."pitVersionLimit"`)
              .delete();
          } catch (err) {
            logger.error(
              `Failed to prune snapshots from current folders in range ${batchEntries[0]}:${
                batchEntries[batchEntries.length - 1]
              }`
            );
          } finally {
            uuidOffset = batchEntries[batchEntries.length - 1];
          }
        } else {
          break;
        }
      }

      // cleanup snapshots from non-current folders
      uuidOffset = "00000000-0000-0000-0000-000000000000";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const folderBatch = await db(TableName.SecretFolderVersion)
          .select("folderId")
          .distinct("folderId")
          .where("folderId", ">", uuidOffset)
          .orderBy("folderId", "asc")
          .limit(PRUNE_FOLDER_BATCH_SIZE);

        const batchEntries = folderBatch.map((folder) => folder.folderId);

        if (folderBatch.length) {
          try {
            logger.info(`Pruning snapshots in range ${batchEntries[0]}:${batchEntries[batchEntries.length - 1]}`);
            await db(TableName.Snapshot)
              .with("snapshot_cte", (qb) => {
                void qb
                  .from(TableName.Snapshot)
                  .whereIn(`${TableName.Snapshot}.folderId`, batchEntries)
                  .select(
                    "folderId",
                    `${TableName.Snapshot}.id as id`,
                    db.raw(
                      `ROW_NUMBER() OVER (PARTITION BY ${TableName.Snapshot}."folderId" ORDER BY ${TableName.Snapshot}."createdAt" DESC) AS row_num`
                    )
                  );
              })
              .join(
                TableName.SecretFolderVersion,
                `${TableName.SecretFolderVersion}.folderId`,
                `${TableName.Snapshot}.folderId`
              )
              .join(TableName.Environment, `${TableName.Environment}.id`, `${TableName.SecretFolderVersion}.envId`)
              .join(TableName.Project, `${TableName.Project}.id`, `${TableName.Environment}.projectId`)
              .join("snapshot_cte", "snapshot_cte.id", `${TableName.Snapshot}.id`)
              .whereRaw(`snapshot_cte.row_num > ${TableName.Project}."pitVersionLimit"`)
              .delete();
          } catch (err) {
            logger.error(
              `Failed to prune snapshots from non-current folders in range ${batchEntries[0]}:${
                batchEntries[batchEntries.length - 1]
              }`
            );
          } finally {
            uuidOffset = batchEntries[batchEntries.length - 1];
          }
        } else {
          break;
        }
      }

      // cleanup orphaned snapshots (those that don't belong to an existing folder and folder version)
      await db(TableName.Snapshot)
        .whereNotIn("folderId", (qb) => {
          void qb
            .select("folderId")
            .from(TableName.SecretFolderVersion)
            .union((qb1) => void qb1.select("id").from(TableName.SecretFolder));
        })
        .delete();
    } catch (error) {
      throw new DatabaseError({ error, name: "SnapshotPrune" });
    }
  };

  return {
    ...secretSnapshotOrm,
    findById,
    findLatestSnapshotByFolderId,
    findRecursivelySnapshots,
    countOfSnapshotsByFolderId,
    findSecretSnapshotDataById,
    pruneExcessSnapshots
  };
};
