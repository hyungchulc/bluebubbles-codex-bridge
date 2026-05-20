#!/usr/bin/env python3
import base64
import json
import plistlib
import sys
from plistlib import UID


def add(objects, value):
    objects.append(value)
    return UID(len(objects) - 1)


def url_uid(objects, value):
    relative = add(objects, value)
    url_class = add(objects, {"$classname": "NSURL", "$classes": ["NSURL", "NSObject"]})
    return add(objects, {"NS.base": UID(0), "$class": url_class, "NS.relative": relative})


def array_uid(objects, values):
    array_class = add(objects, {"$classname": "NSArray", "$classes": ["NSArray", "NSObject"]})
    return add(objects, {"NS.objects": values, "$class": array_class})


def string_uid_or_null(objects, value):
    value = str(value or "").strip()
    return add(objects, value) if value else UID(0)


def postal_address_uid(objects, value, postal_class):
    return add(
        objects,
        {
            "_state": string_uid_or_null(objects, value.get("state")),
            "_formattedAddress": UID(0),
            "$class": postal_class,
            "_city": string_uid_or_null(objects, value.get("city")),
            "_street": string_uid_or_null(objects, value.get("street")),
            "_postalCode": string_uid_or_null(objects, value.get("postalCode")),
            "_country": string_uid_or_null(objects, value.get("country")),
            "_subAdministrativeArea": string_uid_or_null(objects, value.get("subAdministrativeArea")),
            "_subLocality": string_uid_or_null(objects, value.get("subLocality")),
            "_ISOCountryCode": string_uid_or_null(objects, value.get("isoCountryCode")),
        },
    )


def build_apple_maps_directions_payload(metadata, url, title):
    directions = metadata.get("appleMapsDirections") or {}
    resolved_url = str(metadata.get("resolvedUrl") or url).strip() or url
    source_name = str(directions.get("sourceLocationName") or "").strip()
    source_address = str(directions.get("sourceAddress") or source_name or "").strip()
    destination_name = str(directions.get("destinationLocationName") or "").strip()
    destination_address = str(directions.get("destinationAddress") or destination_name or "").strip()
    try:
        transport_type = int(directions.get("transportType") or 1)
    except (TypeError, ValueError):
        transport_type = 1
    try:
        distance = float(directions.get("distance") or 0)
    except (TypeError, ValueError):
        distance = 0.0

    objects = ["$null"]
    root = {"richLinkIsPlaceholder": False}
    link = {
        "originalURL": url_uid(objects, url),
        "URL": url_uid(objects, resolved_url),
        "title": add(objects, title),
        "version": 1,
        "usesActivityPub": False,
    }

    postal_class = add(objects, {"$classname": "CNPostalAddress", "$classes": ["CNPostalAddress", "NSObject"]})
    map_class = add(
        objects,
        {
            "$classname": "LPMapMetadata",
            "$classes": ["LPMapMetadata", "LPSpecializationMetadata", "NSObject"],
        },
    )
    map_metadata = {
        "directionsSourceAddress": string_uid_or_null(objects, source_address),
        "directionsSourceLocationName": string_uid_or_null(objects, source_name or source_address),
        "directionsDestinationLocationName": string_uid_or_null(objects, destination_name or destination_address),
        "directionsDestinationAddress": string_uid_or_null(objects, destination_address),
        "distance": add(objects, distance),
        "directionsDestinationAddressComponents": postal_address_uid(
            objects,
            directions.get("destinationAddressComponents") or {},
            postal_class,
        ),
        "isPointOfInterest": False,
        "$class": map_class,
        "transportType": add(objects, transport_type),
        "directionsSourceAddressComponents": postal_address_uid(
            objects,
            directions.get("sourceAddressComponents") or {},
            postal_class,
        ),
    }
    link["specialization2"] = add(objects, map_metadata)

    link_class = add(objects, {"$classname": "LPLinkMetadata", "$classes": ["LPLinkMetadata", "NSObject"]})
    link["$class"] = link_class
    link_uid = add(objects, link)
    root["richLinkMetadata"] = link_uid
    root_class = add(objects, {"$classname": "RichLink"})
    root["$class"] = root_class
    root_uid = add(objects, root)

    return {
        "$version": 100000,
        "$archiver": "NSKeyedArchiver",
        "$top": {"root": root_uid},
        "$objects": objects,
    }


def main():
    metadata = json.load(sys.stdin)
    url = str(metadata.get("url") or "").strip()
    if not url:
        raise SystemExit("url is required")

    title = str(metadata.get("title") or url).strip() or url
    summary = str(metadata.get("summary") or "").strip()
    site_name = str(metadata.get("siteName") or "").strip()
    icon_url = str(metadata.get("iconUrl") or "").strip()
    image_url = str(metadata.get("imageUrl") or "").strip()
    mime_type = str(metadata.get("mimeType") or "image/png").strip() or "image/png"
    attachment_role = str(metadata.get("attachmentRole") or "").strip().lower()
    attachment_url = str(metadata.get("attachmentSourceUrl") or "").strip()

    if metadata.get("appleMapsDirections"):
        payload = build_apple_maps_directions_payload(metadata, url, title)
        sys.stdout.write(
            base64.b64encode(plistlib.dumps(payload, fmt=plistlib.FMT_BINARY, sort_keys=False)).decode("ascii")
        )
        return

    objects = ["$null"]
    root = {"richLinkIsPlaceholder": False}
    link = {
        "originalURL": url_uid(objects, url),
        "URL": url_uid(objects, str(metadata.get("resolvedUrl") or url).strip() or url),
        "title": add(objects, title),
        "version": 1,
        "usesActivityPub": False,
    }

    if summary:
        link["summary"] = add(objects, summary)
    if site_name:
        link["siteName"] = add(objects, site_name)
    substitute_class = None
    if attachment_role in ("icon", "image") and not attachment_url:
        attachment_url = icon_url if attachment_role == "icon" else image_url
    if attachment_role in ("icon", "image") and attachment_url:
        substitute_class = add(objects, {"$classname": "RichLinkImageAttachmentSubstitute"})
    if icon_url:
        if attachment_role == "icon" and substitute_class is not None:
            link["icon"] = add(
                objects,
                {
                    "imageType": 0,
                    "richLinkImageAttachmentSubstituteIndex": 0,
                    "MIMEType": add(objects, mime_type),
                    "$class": substitute_class,
                },
            )
        icon_class = add(objects, {"$classname": "LPIconMetadata", "$classes": ["LPIconMetadata", "NSObject"]})
        icon_metadata = add(objects, {"version": 1, "URL": url_uid(objects, icon_url), "$class": icon_class})
        link["iconMetadata"] = icon_metadata
        link["icons"] = array_uid(objects, [icon_metadata])
    if image_url:
        image_class = add(objects, {"$classname": "LPImageMetadata", "$classes": ["LPImageMetadata", "NSObject"]})
        image_metadata = add(
            objects,
            {
                "version": 1,
                "URL": url_uid(objects, image_url),
                "size": add(objects, "{0, 0}"),
                "$class": image_class,
            },
        )
        if attachment_role == "image" and substitute_class is not None:
            link["image"] = add(
                objects,
                {
                    "imageType": 0,
                    "richLinkImageAttachmentSubstituteIndex": 0,
                    "MIMEType": add(objects, mime_type),
                    "$class": substitute_class,
                },
            )
            link["imageMetadata"] = image_metadata
        link["images"] = array_uid(objects, [image_metadata])
    if site_name or icon_url or image_url:
        link["itemType"] = add(objects, "website")

    link_class = add(objects, {"$classname": "LPLinkMetadata", "$classes": ["LPLinkMetadata", "NSObject"]})
    link["$class"] = link_class
    link_uid = add(objects, link)
    root["richLinkMetadata"] = link_uid
    root_class = add(objects, {"$classname": "RichLink"})
    root["$class"] = root_class
    root_uid = add(objects, root)

    payload = {
        "$version": 100000,
        "$archiver": "NSKeyedArchiver",
        "$top": {"root": root_uid},
        "$objects": objects,
    }
    sys.stdout.write(
        base64.b64encode(plistlib.dumps(payload, fmt=plistlib.FMT_BINARY, sort_keys=False)).decode("ascii")
    )


if __name__ == "__main__":
    main()
