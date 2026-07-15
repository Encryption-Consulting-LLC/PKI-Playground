"""Helpers for comparing VMware guest OS identifiers across API surfaces."""


def guest_os_ids_match(actual: str | None, expected: str) -> bool:
    """Match a VMX ``guestOS`` value with vSphere's ``config.guestId`` value.

    VMX files use identifiers such as ``windows2022srvNext-64``, while the
    vSphere API reports the equivalent enum value as
    ``windows2022srvNext_64Guest``. Keep the VMX form in settings because it is
    also passed to clone rendering, but accept either representation during
    inventory validation.
    """

    if not actual:
        return False
    if actual == expected:
        return True

    # Common Linux ids use ``ubuntu-64`` in VMX but ``ubuntu64Guest`` in the
    # inventory API. Normalizing separators and the API suffix also covers the
    # Windows ``-64``/``_64Guest`` pair below without special-casing a distro.
    def normalized(value: str) -> str:
        if value.endswith("Guest"):
            value = value.removesuffix("Guest")
        return value.replace("-", "").replace("_", "").casefold()

    if normalized(actual) == normalized(expected):
        return True

    api_suffix = "_64Guest"
    vmx_suffix = "-64"
    if actual.endswith(api_suffix) and expected.endswith(vmx_suffix):
        return actual.removesuffix(api_suffix) == expected.removesuffix(vmx_suffix)
    if actual.endswith(vmx_suffix) and expected.endswith(api_suffix):
        return actual.removesuffix(vmx_suffix) == expected.removesuffix(api_suffix)
    return False
