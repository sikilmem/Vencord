/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { copyWithToast } from "@utils/discord";
import { Toasts } from "@webpack/common";

import { Native, settings } from "../..";
import { DEFAULT_IMAGE_CACHE_DIR } from "../../utils/constants";

const cl = classNameFactory("folder-upload");

function createDirSelector(settingKey: "logsDir" | "imageCacheDir", successMessage: string) {
    return function DirSelector({ option }) {
        // Check if we're in web environment
        if (typeof window !== "undefined" && window.location.protocol === "https:") return null;

        return (
            <section>
                <Heading tag="h5">{option.description}</Heading>
                <SelectFolderInput
                    settingsKey={settingKey}
                    successMessage={successMessage}
                />
            </section>
        );
    };
}

export const ImageCacheDir = createDirSelector("imageCacheDir", "Successfully updated Image Cache Dir");
export const LogsDir = createDirSelector("logsDir", "Successfully updated Logs Dir");

interface Props {
    settingsKey: "imageCacheDir" | "logsDir",
    successMessage: string,
}

export function SelectFolderInput({ settingsKey, successMessage }: Props) {
    const path = settings.store[settingsKey];

    function getDirName(path: string) {
        const parts = path.split("\\").length > 1 ? path.split("\\") : path.split("/");

        return parts.slice(parts.length - 2, parts.length).join("\\");
    }

    async function onFolderSelect() {
        try {
            const res = await Native.chooseDir(settingsKey);
            settings.store[settingsKey] = res;

            return Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS,
                message: successMessage
            });
        } catch (err) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: "Failed to update directory"
            });
        }
    }

    return (
        <div style={{
            display: "flex",
            gap: "8px",
            alignItems: "center",
            padding: "8px",
            border: "1px solid var(--background-modifier-accent)",
            borderRadius: "4px",
            backgroundColor: "var(--background-secondary)"
        }}>
            <div
                onClick={() => copyWithToast(path)}
                style={{
                    flex: 1,
                    padding: "8px 12px",
                    backgroundColor: "var(--background-primary)",
                    border: "1px solid var(--background-modifier-accent)",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "14px"
                }}
            >
                {path == null || path === DEFAULT_IMAGE_CACHE_DIR ? "Choose Folder" : getDirName(path)}
            </div>
            <Button
                size="small"
                onClick={onFolderSelect}
            >
                Browse
            </Button>
        </div>
    );

}
