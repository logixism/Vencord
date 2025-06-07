// yoinked from official repo

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
  name: "NSFWGateBypass",
  description: "Allows you to access NSFW channels without setting/verifying your age",
  authors: [Devs.Commandtechno],
  patches: [
    {
      find: ".nsfwAllowed=null",
      replacement: [
        {
          match: /(?<=\.nsfwAllowed=)null!=.+?(?=[,;])/,
          replace: "true",
        },
        {
          match: /(?<=\.ageVerificationStatus=)null!=.+?(?=[,;])/,
          replace: "3", // VERIFIED_ADULT
        }
      ],
    }
  ],
});