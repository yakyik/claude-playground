package config

// StrategicMerge performs a Kubernetes-style strategic merge of overlay onto base.
//   - Scalars: overlay replaces base
//   - Maps: recursive merge
//   - Slices of maps with a "name" key: merge by name
//   - Scalar slices: overlay replaces entirely
//   - nil overlay: base preserved
func StrategicMerge(base, overlay interface{}) interface{} {
	if overlay == nil {
		return base
	}
	if base == nil {
		return overlay
	}

	baseMap, baseIsMap := toStringMap(base)
	overlayMap, overlayIsMap := toStringMap(overlay)
	if baseIsMap && overlayIsMap {
		return mergeMaps(baseMap, overlayMap)
	}

	baseSlice, baseIsSlice := toSlice(base)
	overlaySlice, overlayIsSlice := toSlice(overlay)
	if baseIsSlice && overlayIsSlice {
		return mergeSlices(baseSlice, overlaySlice)
	}

	return overlay
}

func mergeMaps(base, overlay map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{}, len(base))
	for k, v := range base {
		result[k] = v
	}
	for k, v := range overlay {
		if v == nil {
			continue
		}
		if existing, ok := result[k]; ok {
			result[k] = StrategicMerge(existing, v)
		} else {
			result[k] = v
		}
	}
	return result
}

func mergeSlices(base, overlay []interface{}) interface{} {
	if isNamedSlice(base) && isNamedSlice(overlay) {
		return mergeNamedSlices(base, overlay)
	}
	return overlay
}

func mergeNamedSlices(base, overlay []interface{}) []interface{} {
	result := make([]interface{}, len(base))
	for i, v := range base {
		if m, ok := toStringMap(v); ok {
			cp := make(map[string]interface{}, len(m))
			for k, val := range m {
				cp[k] = val
			}
			result[i] = cp
		} else {
			result[i] = v
		}
	}

	for _, ov := range overlay {
		om, _ := toStringMap(ov)
		name := om["name"]
		found := false
		for i, bv := range result {
			bm, _ := toStringMap(bv)
			if bm["name"] == name {
				result[i] = StrategicMerge(bv, ov)
				found = true
				break
			}
		}
		if !found {
			result = append(result, ov)
		}
	}
	return result
}

func isNamedSlice(s []interface{}) bool {
	if len(s) == 0 {
		return false
	}
	for _, item := range s {
		m, ok := toStringMap(item)
		if !ok {
			return false
		}
		if _, hasName := m["name"]; !hasName {
			return false
		}
	}
	return true
}

func toStringMap(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}

func toSlice(v interface{}) ([]interface{}, bool) {
	s, ok := v.([]interface{})
	return s, ok
}
