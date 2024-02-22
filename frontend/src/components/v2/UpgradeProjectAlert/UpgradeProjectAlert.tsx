import { useCallback, useState } from "react";
import { useRouter } from "next/router";
import { faWarning } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import { useNotificationContext } from "@app/components/context/Notifications/NotificationProvider";
import { useProjectPermission } from "@app/context";
import { useGetUpgradeProjectStatus, useUpgradeProject } from "@app/hooks/api";
import { Workspace } from "@app/hooks/api/types";
import { ProjectVersion } from "@app/hooks/api/workspace/types";

import { Button } from "../Button";

export type UpgradeProjectAlertProps = {
  project: Workspace;
};

export const UpgradeProjectAlert = ({ project }: UpgradeProjectAlertProps): JSX.Element | null => {
  const { createNotification } = useNotificationContext();
  const router = useRouter();
  const { membership } = useProjectPermission();
  const upgradeProject = useUpgradeProject();
  const [currentStatus, setCurrentStatus] = useState<string | null>(null);
  const [isUpgrading, setIsUpgrading] = useState(false);

  const {
    data: projectStatus,
    isLoading: statusIsLoading,
    refetch: manualProjectStatusRefetch
  } = useGetUpgradeProjectStatus({
    projectId: project.id,
    enabled: membership.role === "admin" && project.version === ProjectVersion.V1,
    refetchInterval: 5_000,
    onSuccess: (data) => {
      if (membership.role !== "admin") {
        return;
      }

      if (data && data?.status !== null) {
        if (data.status === "IN_PROGRESS") {
          setCurrentStatus("Your upgrade is being processed.");
        } else if (data.status === "FAILED") {
          setCurrentStatus("Upgrade failed, please try again.");
        }
      }

      if (currentStatus !== null && data?.status === null) {
        router.reload();
      }
    }
  });

  const onUpgradeProject = useCallback(async () => {
    if (upgradeProject.isLoading) {
      return;
    }
    setIsUpgrading(true);
    const PRIVATE_KEY = localStorage.getItem("PRIVATE_KEY");

    if (!PRIVATE_KEY) {
      createNotification({
        type: "error",
        text: "Private key not found"
      });
      return;
    }

    await upgradeProject.mutateAsync({
      projectId: project.id,
      privateKey: PRIVATE_KEY
    });

    manualProjectStatusRefetch();

    setTimeout(() => setIsUpgrading(false), 5_000);
  }, []);

  const isLoading =
    isUpgrading ||
    ((upgradeProject.isLoading ||
      currentStatus !== null ||
      (currentStatus === null && statusIsLoading)) &&
      projectStatus?.status !== "FAILED");

  if (project.version !== ProjectVersion.V1) return null;
  if (membership.role !== "admin") return null;

  return (
    <div className="mt-4 flex w-full flex-row items-center rounded-md border border-primary-600/70 bg-primary/[.07] p-4 text-base text-white">
      <FontAwesomeIcon icon={faWarning} className="pr-6 text-6xl text-white/80" />
      <div className="flex w-full flex-col text-sm">
        <span className="mb-2 text-lg font-semibold">Upgrade your project</span>
        Upgrade your project version to continue receiving the latest improvements and patches.
        {currentStatus && <p className="mt-2 opacity-80">Status: {currentStatus}</p>}
      </div>
      <div className="my-2">
        <Button isLoading={isLoading} isDisabled={isLoading} onClick={onUpgradeProject}>
          Upgrade
        </Button>
      </div>
    </div>
  );
};